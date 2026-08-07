import { Bot, GrammyError, InlineKeyboard } from "grammy";
import {
  addReminder,
  addTask,
  closeDb,
  dueReminders,
  getTask,
  listReminders,
  listTasks,
  markSent,
  removeTask,
  setDeadline,
  type Reminder,
  type Task,
} from "./db.ts";
import {
  datePicker,
  formatDeadline,
  hourPicker,
  isOverdue,
  minutePicker,
  nowLocal,
  parseTime,
  ymd,
  type Mode,
} from "./pickers.ts";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error(
    "BOT_TOKEN is not set. Copy .env.example to .env and paste the token from @BotFather.",
  );
  process.exit(1);
}

const MAX_TASK_LENGTH = 500;
const REMINDER_POLL_MS = 30_000;

/** Chats that sent a bare /add and are expected to reply with the task text. */
const awaitingTaskText = new Set<number>();

/** Chats that tapped "Type a time" and owe us an HH:MM. Losing this on restart
 *  costs nothing — the date is still chosen, they just tap the button again. */
const awaitingTime = new Map<
  number,
  { mode: Mode; taskId: number; date: string }
>();

export const bot = new Bot(token);

/** A new command abandons any half-finished /add or typed-time prompt. */
function resetPending(chatId: number): void {
  awaitingTaskText.delete(chatId);
  awaitingTime.delete(chatId);
}

/** Telegram's HTML parse mode only needs these three escaped. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Button label — always carries the date/time so tasks are identifiable at a glance. */
function taskLabel(task: Task): string {
  const when = task.deadline ? formatDeadline(task.deadline) : "no date";
  return `${truncate(task.text, 28)} · ${when}`;
}

/** List line — same idea, with an overdue flag. */
function describe(task: Task): string {
  if (!task.deadline) return `${esc(task.text)} — <i>no date</i>`;
  const when = formatDeadline(task.deadline);
  return isOverdue(task.deadline)
    ? `${esc(task.text)} — <b>${when}</b> ⚠️`
    : `${esc(task.text)} — <b>${when}</b>`;
}

function taskKeyboard(tasks: Task[], prefix: "rm" | "rem"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const task of tasks) {
    keyboard.text(taskLabel(task), `${prefix}:${task.id}`).row();
  }
  return keyboard;
}

// ── Commands ───────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  resetPending(ctx.chat.id);
  await ctx.reply(
    [
      "👋 <b>Hi! I keep your todo list.</b>",
      "",
      "<b>/add</b> <i>task</i> — add a task, then pick its date &amp; time",
      "<b>/list</b> — see everything, soonest first",
      "<b>/reminder</b> — get pinged about a task",
      "<b>/remove</b> — remove a task",
      "",
      "That's it. Try <code>/add buy milk</code>.",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

bot.command("add", async (ctx) => {
  const text = ctx.match.trim();
  awaitingTime.delete(ctx.chat.id);
  if (!text) {
    awaitingTaskText.add(ctx.chat.id);
    await ctx.reply("What's the task? Send it as your next message.");
    return;
  }
  await saveTask(ctx, text);
});

bot.command("list", async (ctx) => {
  resetPending(ctx.chat.id);
  const userId = ctx.from?.id;
  if (!userId) return;

  const tasks = listTasks(userId);
  if (tasks.length === 0) {
    await ctx.reply("Your list is empty. 🎉  Add one with <code>/add</code>.", {
      parse_mode: "HTML",
    });
    return;
  }

  const byTask = new Map<number, Reminder[]>();
  for (const r of listReminders(userId)) {
    byTask.set(r.task_id, [...(byTask.get(r.task_id) ?? []), r]);
  }

  const lines: string[] = [];
  tasks.forEach((task, i) => {
    lines.push(`${i + 1}. ${describe(task)}`);
    for (const r of byTask.get(task.id) ?? []) {
      lines.push(`    🔔 ${formatDeadline(r.remind_at)}`);
    }
  });

  const overdue = tasks.filter((t) => t.deadline && isOverdue(t.deadline)).length;

  await ctx.reply(
    [
      `<b>Your tasks (${tasks.length})</b>`,
      "",
      ...lines,
      ...(overdue > 0 ? ["", `⚠️ ${overdue} overdue`] : []),
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

bot.command("reminder", async (ctx) => {
  resetPending(ctx.chat.id);
  const userId = ctx.from?.id;
  if (!userId) return;

  const tasks = listTasks(userId);
  if (tasks.length === 0) {
    await ctx.reply("No tasks yet — add one with <code>/add</code> first.", {
      parse_mode: "HTML",
    });
    return;
  }

  await ctx.reply("Remind you about which task?", {
    reply_markup: taskKeyboard(tasks, "rem"),
  });
});

bot.command("remove", async (ctx) => {
  resetPending(ctx.chat.id);
  const userId = ctx.from?.id;
  if (!userId) return;

  const tasks = listTasks(userId);
  if (tasks.length === 0) {
    await ctx.reply("Nothing to remove — your list is empty. 🎉");
    return;
  }

  await ctx.reply("Which one is done?", {
    reply_markup: taskKeyboard(tasks, "rm"),
  });
});

// ── Date / time picker, shared by the deadline and reminder flows ──────────

// Inert cells: weekday headers, blanks, and past days.
bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

/** Task chosen for a reminder — hand off to the same picker the add flow uses. */
bot.callbackQuery(/^rem:(\d+)$/, async (ctx) => {
  const taskId = Number(ctx.match[1]);
  const task = getTask(ctx.from.id, taskId);
  if (!task) return expired(ctx);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`When should I remind you about <b>${esc(task.text)}</b>?`, {
    parse_mode: "HTML",
    reply_markup: datePicker("r", taskId, ymd(new Date()).slice(0, 7)),
  });
});

bot.callbackQuery(/^cal:([dr]):(\d+):(\d{4}-\d{2})$/, async (ctx) => {
  const mode = ctx.match[1] as Mode;
  const taskId = Number(ctx.match[2]);
  const task = getTask(ctx.from.id, taskId);
  if (!task) return expired(ctx);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(prompt(mode, task.text), {
    parse_mode: "HTML",
    reply_markup: datePicker(mode, taskId, ctx.match[3] ?? ""),
  });
});

bot.callbackQuery(/^day:([dr]):(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const mode = ctx.match[1] as Mode;
  const taskId = Number(ctx.match[2]);
  const date = ctx.match[3] ?? "";
  const task = getTask(ctx.from.id, taskId);
  if (!task) return expired(ctx);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b>${esc(task.text)}</b>\n${formatDeadline(date)} — what time?`,
    { parse_mode: "HTML", reply_markup: hourPicker(mode, taskId, date) },
  );
});

bot.callbackQuery(/^hr:([dr]):(\d+):(\d{4}-\d{2}-\d{2}):(\d{2})$/, async (ctx) => {
  const mode = ctx.match[1] as Mode;
  const taskId = Number(ctx.match[2]);
  const date = ctx.match[3] ?? "";
  const hour = ctx.match[4] ?? "";
  const task = getTask(ctx.from.id, taskId);
  if (!task) return expired(ctx);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b>${esc(task.text)}</b>\n${formatDeadline(date)} at ${hour}:__ — minutes?`,
    { parse_mode: "HTML", reply_markup: minutePicker(mode, taskId, date, hour) },
  );
});

bot.callbackQuery(
  /^min:([dr]):(\d+):(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/,
  async (ctx) => {
    const mode = ctx.match[1] as Mode;
    const taskId = Number(ctx.match[2]);
    const when = `${ctx.match[3]} ${ctx.match[4]}:${ctx.match[5]}`;

    if (!getTask(ctx.from.id, taskId)) return expired(ctx);

    const result = commitWhen(mode, ctx.from.id, taskId, when);
    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: result.text, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery(mode === "d" ? "Date set" : "Reminder set");
    await ctx.editMessageText(result.text, { parse_mode: "HTML" });
  },
);

/** "Type a time" — remember what we're timing, then wait for their next message. */
bot.callbackQuery(/^type:([dr]):(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const mode = ctx.match[1] as Mode;
  const taskId = Number(ctx.match[2]);
  const date = ctx.match[3] ?? "";

  const task = getTask(ctx.from.id, taskId);
  if (!task) return expired(ctx);

  awaitingTime.set(ctx.chat?.id ?? ctx.from.id, { mode, taskId, date });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b>${esc(task.text)}</b>\n${formatDeadline(date)} — send me the time.\n\n` +
      `<i>Like</i> <code>14:37</code><i>, </i><code>9:05</code><i>, or </i><code>2:30pm</code>`,
    { parse_mode: "HTML" },
  );
});

bot.callbackQuery(/^allday:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await finishDeadline(ctx, Number(ctx.match[1]), ctx.match[2] ?? "");
});

bot.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
  await finishDeadline(ctx, Number(ctx.match[1]), null);
});

bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Cancelled");
  await ctx.editMessageText("No reminder set.").catch(() => {});
});

// ── Remove flow ────────────────────────────────────────────────────────────

bot.callbackQuery(/^rm:(\d+)$/, async (ctx) => {
  const removed = removeTask(ctx.from.id, Number(ctx.match[1]));

  if (!removed) {
    await ctx.answerCallbackQuery("Already gone.");
    // The message's buttons are stale — drop them so nothing else can be tapped.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery("Removed");

  const remaining = listTasks(ctx.from.id);
  const header = `✅ Removed <s>${esc(removed.text)}</s>`;

  if (remaining.length === 0) {
    await ctx.editMessageText(`${header}\n\nList's empty. 🎉`, {
      parse_mode: "HTML",
    });
    return;
  }

  await ctx.editMessageText(`${header}\n\nAnything else?`, {
    parse_mode: "HTML",
    reply_markup: taskKeyboard(remaining, "rm"),
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function prompt(mode: Mode, text: string): string {
  return mode === "d"
    ? `When is <b>${esc(text)}</b> due?`
    : `When should I remind you about <b>${esc(text)}</b>?`;
}

type PickerCtx = {
  from: { id: number };
  answerCallbackQuery: (
    text?: string | { text: string; show_alert?: boolean },
  ) => Promise<unknown>;
  editMessageText: (
    text: string,
    other?: { parse_mode?: "HTML"; reply_markup?: InlineKeyboard },
  ) => Promise<unknown>;
};

/** The task was deleted (or isn't this user's) while the picker sat open. */
async function expired(ctx: PickerCtx): Promise<void> {
  await ctx.answerCallbackQuery("That task is gone.");
  await ctx.editMessageText("That task no longer exists.").catch(() => {});
}

async function finishDeadline(
  ctx: PickerCtx,
  taskId: number,
  deadline: string | null,
): Promise<void> {
  const task = setDeadline(ctx.from.id, taskId, deadline);
  if (!task) return expired(ctx);

  await ctx.answerCallbackQuery(deadline ? "Date set" : "Saved");
  await ctx.editMessageText(
    `✅ Added ${describe(task)}\n\n<i>Want a nudge? /reminder</i>`,
    { parse_mode: "HTML" },
  );
}

/**
 * Writes a chosen "YYYY-MM-DD HH:MM" as either the task's deadline or a new
 * reminder, and returns the message to show. Shared by the minute buttons and
 * the typed-time path so both behave identically.
 */
function commitWhen(
  mode: Mode,
  userId: number,
  taskId: number,
  when: string,
): { ok: true; text: string } | { ok: false; text: string } {
  if (mode === "d") {
    const task = setDeadline(userId, taskId, when);
    if (!task) return { ok: false, text: "That task no longer exists." };
    return {
      ok: true,
      text: `✅ Added ${describe(task)}\n\n<i>Want a nudge? /reminder</i>`,
    };
  }

  // A reminder in the past would fire the moment it's saved.
  if (when <= nowLocal()) {
    return { ok: false, text: "That time has already passed — pick a later one." };
  }

  const task = getTask(userId, taskId);
  if (!task) return { ok: false, text: "That task no longer exists." };
  if (!addReminder(userId, taskId, when)) {
    return { ok: false, text: "That task no longer exists." };
  }

  return {
    ok: true,
    text: `🔔 I'll remind you about <b>${esc(task.text)}</b> on <b>${formatDeadline(when)}</b>.`,
  };
}

// Free-text follow-ups: a typed time, or the text for a bare /add.
bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  const pending = awaitingTime.get(ctx.chat.id);

  if (pending && userId) {
    const time = parseTime(ctx.message.text);
    if (!time) {
      // Stay in the typing state so they can just correct themselves.
      await ctx.reply(
        "I couldn't read that as a time. Try <code>14:37</code> or <code>2:30pm</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }

    awaitingTime.delete(ctx.chat.id);
    const result = commitWhen(
      pending.mode,
      userId,
      pending.taskId,
      `${pending.date} ${time}`,
    );
    await ctx.reply(result.text, { parse_mode: "HTML" });
    return;
  }

  if (!awaitingTaskText.has(ctx.chat.id)) return;
  resetPending(ctx.chat.id);
  await saveTask(ctx, ctx.message.text.trim());
});

type ReplyCtx = {
  from?: { id: number };
  reply: (
    text: string,
    other?: { parse_mode?: "HTML"; reply_markup?: InlineKeyboard },
  ) => Promise<unknown>;
};

async function saveTask(ctx: ReplyCtx, text: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!text) {
    await ctx.reply("That looked empty — try again with /add.");
    return;
  }
  if (text.length > MAX_TASK_LENGTH) {
    await ctx.reply(`Keep it under ${MAX_TASK_LENGTH} characters, please.`);
    return;
  }

  // Saved straight away with no deadline, so the picker below can stay stateless:
  // every button carries the task id, and an abandoned pick just leaves it undated.
  const task = addTask(userId, text);

  await ctx.reply(prompt("d", task.text), {
    parse_mode: "HTML",
    reply_markup: datePicker("d", task.id, ymd(new Date()).slice(0, 7)),
  });
}

// ── Reminder delivery ──────────────────────────────────────────────────────

/** Sends anything now due. Reminders missed while the bot was down fire late, not never. */
export async function deliverDueReminders(): Promise<number> {
  const now = nowLocal();
  let sent = 0;

  for (const r of dueReminders(now)) {
    try {
      await bot.api.sendMessage(
        r.user_id,
        `🔔 <b>Reminder</b>\n${esc(r.text)}`,
        { parse_mode: "HTML" },
      );
      markSent(r.id, now);
      sent++;
    } catch (err) {
      // 403 = user blocked the bot. Retrying forever would just spin, so retire it.
      if (err instanceof GrammyError && err.error_code === 403) {
        markSent(r.id, now);
      } else {
        console.error(`Failed to send reminder ${r.id}:`, err);
      }
    }
  }
  return sent;
}

bot.catch((err) => {
  console.error(`Error handling update ${err.ctx.update.update_id}:`, err.error);
});

// Skipped under test, where the harness drives updates directly.
if (!process.env.BOT_TEST_MODE) {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "What this bot does" },
      { command: "add", description: "Add a task" },
      { command: "list", description: "Show all tasks" },
      { command: "reminder", description: "Get reminded about a task" },
      { command: "remove", description: "Remove a task" },
    ]);
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 401) {
      console.error("BOT_TOKEN was rejected by Telegram. Check it with @BotFather.");
      process.exit(1);
    }
    throw err;
  }

  const timer = setInterval(() => {
    void deliverDueReminders();
  }, REMINDER_POLL_MS);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      void bot.stop().then(closeDb);
    });
  }

  console.log("Bot starting…");
  await bot.start({
    onStart: (me) => console.log(`Listening as @${me.username}`),
  });
}

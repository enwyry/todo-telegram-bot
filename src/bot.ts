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
  removeReminder,
  removeTask,
  setDeadline,
  taskReminders,
  type Reminder,
  type Task,
} from "./db.ts";
import {
  datePicker,
  formatDeadline,
  hourPicker,
  isOverdue,
  minutePicker,
  nextMinute,
  nowLocal,
  parseTime,
  ymd,
  type Bounds,
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

/**
 * Double-tapping a button that re-renders the same view (month navigation, the
 * remove menu) asks Telegram to replace a message with what it already says,
 * which it rejects with 400 "message is not modified". The tap is a no-op by
 * definition, so it's swallowed here — once, centrally, rather than at each of
 * the ~20 edit call sites where one would inevitably be missed.
 */
export function isNoOpEditFailure(
  method: string,
  res: { ok: boolean; description?: string },
): boolean {
  if (res.ok) return false;
  if (method !== "editMessageText" && method !== "editMessageReplyMarkup") {
    return false;
  }
  return /message is not modified/i.test(res.description ?? "");
}

bot.api.config.use(async (prev, method, payload, signal) => {
  // grammY turns an `ok: false` response into a GrammyError *after* the
  // transformer stack, so this has to inspect the response — a try/catch here
  // would never fire.
  const res = await prev(method, payload, signal);
  if (isNoOpEditFailure(method, res)) {
    return { ok: true, result: true } as typeof res;
  }
  return res;
});

/**
 * Private chats only.
 *
 * Lists are per-user but the half-finished-command state above is per-chat, and
 * reminders are always delivered to a user's private chat. In a group those
 * disagree: one member's message can land in another's pending prompt, and a
 * reminder for a group-created task goes somewhere the group can't see. Rather
 * than half-support that, the bot says so and stays out.
 */
bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== "private") {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: "Message me privately to use this bot.",
        show_alert: true,
      });
    } else if (ctx.message?.text?.startsWith("/")) {
      await ctx.reply("I only work in a private chat — message me directly.");
    }
    return;
  }
  await next();
});

/** A new command abandons any half-finished /add or typed-time prompt. */
function resetPending(chatId: number): void {
  awaitingTaskText.delete(chatId);
  awaitingTime.delete(chatId);
}

/** Telegram's HTML parse mode only needs these three escaped. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Truncates by grapheme, so an emoji is never cut into a broken half-character. */
function truncate(text: string, max: number): string {
  const parts = [...graphemes.segment(text)].map((s) => s.segment);
  return parts.length <= max ? text : `${parts.slice(0, max - 1).join("")}…`;
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

/** Telegram rejects anything longer than this (verified: 4096 ok, 4097 not). */
const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Sends `lines` as however many messages it takes. A single 500-character task
 * can reach ~2500 characters once escaped (`&` becomes `&amp;`), so a long list
 * would otherwise blow the limit and fail with no reply at all.
 */
async function replyInChunks(ctx: ReplyCtx, lines: string[]): Promise<void> {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    // A line longer than a whole message can't be batched — cut it, taking care
    // not to leave a half-written HTML entity behind.
    const safe =
      line.length > TELEGRAM_TEXT_LIMIT
        ? `${line.slice(0, TELEGRAM_TEXT_LIMIT - 1).replace(/&[a-z]*$/i, "")}…`
        : line;

    const candidate = current ? `${current}\n${safe}` : safe;
    if (candidate.length > TELEGRAM_TEXT_LIMIT) {
      if (current) chunks.push(current);
      current = safe;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: "HTML" });
  }
}

function taskKeyboard(tasks: Task[], prefix: "rm" | "rem"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const task of tasks) {
    keyboard.text(taskLabel(task), `${prefix}:${task.id}`).row();
  }
  return keyboard;
}

function reminderKeyboard(reminders: Reminder[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const r of reminders) {
    keyboard
      .text(
        `🔔 ${formatDeadline(r.remind_at)} · ${truncate(r.text, 22)}`,
        `rmr:${r.id}`,
      )
      .row();
  }
  return keyboard;
}

/**
 * A reminder is only useful between now and the task's deadline, so the picker
 * is bounded to that window. An all-day deadline allows any time that day.
 * Deadlines themselves are unbounded — the calendar already blocks past days.
 */
function boundsFor(mode: Mode, task: Task): Bounds {
  if (mode === "d") return {};

  // The floor is the next minute, not this one: the current minute is already
  // partly spent and commitWhen would reject it, so offering it is a dead end.
  const min = nextMinute();
  if (!task.deadline) return { min };

  // An all-day deadline still allows any time on that day.
  const max = task.deadline.includes(" ") ? task.deadline : `${task.deadline} 23:59`;

  // Already overdue: capping at the deadline would leave no slot at all, so the
  // cap is dropped and you can still be reminded about a late task. `max < min`
  // (not `<=`) keeps a deadline exactly one minute away usable.
  return max < min ? { min } : { min, max };
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
  // Clear first: an earlier bare /add could still be waiting, and leaving it
  // armed would turn the next ordinary message into a second task.
  resetPending(ctx.chat.id);
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

  await replyInChunks(ctx, [
    `<b>Your tasks (${tasks.length})</b>`,
    "",
    ...lines,
    ...(overdue > 0 ? ["", `⚠️ ${overdue} overdue`] : []),
  ]);
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

  // Only ask task-or-reminder when there's actually a reminder to choose.
  const reminders = listReminders(userId);
  if (reminders.length === 0) {
    await ctx.reply("Which one is done?", {
      reply_markup: taskKeyboard(tasks, "rm"),
    });
    return;
  }

  await ctx.reply("What do you want to remove?", {
    reply_markup: new InlineKeyboard()
      .text(`🗒 A task (${tasks.length})`, "rmenu:t")
      .row()
      .text(`🔔 A reminder (${reminders.length})`, "rmenu:r"),
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
    reply_markup: datePicker(
      "r",
      taskId,
      ymd(new Date()).slice(0, 7),
      boundsFor("r", task),
    ),
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
    reply_markup: datePicker(
      mode,
      taskId,
      ctx.match[3] ?? "",
      boundsFor(mode, task),
    ),
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
    {
      parse_mode: "HTML",
      reply_markup: hourPicker(mode, taskId, date, boundsFor(mode, task)),
    },
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
    {
      parse_mode: "HTML",
      reply_markup: minutePicker(mode, taskId, date, hour, boundsFor(mode, task)),
    },
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

bot.callbackQuery("rmenu:t", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Which one is done?", {
    reply_markup: taskKeyboard(listTasks(ctx.from.id), "rm"),
  });
});

bot.callbackQuery("rmenu:r", async (ctx) => {
  const reminders = listReminders(ctx.from.id);
  await ctx.answerCallbackQuery();
  if (reminders.length === 0) {
    await ctx.editMessageText("No reminders pending.");
    return;
  }
  await ctx.editMessageText("Which reminder should I drop?", {
    reply_markup: reminderKeyboard(reminders),
  });
});

/** Deleting a task takes its reminders with it, so say so before doing it. */
bot.callbackQuery(/^rm:(\d+)$/, async (ctx) => {
  const taskId = Number(ctx.match[1]);
  const task = getTask(ctx.from.id, taskId);

  if (!task) {
    await ctx.answerCallbackQuery("Already gone.");
    // The message's buttons are stale — drop them so nothing else can be tapped.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return;
  }

  const pending = taskReminders(ctx.from.id, taskId);
  if (pending.length === 0) {
    await deleteTaskNow(ctx, taskId);
    return;
  }

  const plural = pending.length === 1 ? "reminder" : "reminders";
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    [
      `⚠️ <b>${esc(task.text)}</b> has ${pending.length} ${plural}:`,
      ...pending.map((r) => `    🔔 ${formatDeadline(r.remind_at)}`),
      "",
      `Deleting the task cancels ${pending.length === 1 ? "it" : "them"} too.`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("Delete anyway", `rmyes:${taskId}`)
        .text("Keep it", "rmno"),
    },
  );
});

bot.callbackQuery(/^rmyes:(\d+)$/, async (ctx) => {
  await deleteTaskNow(ctx, Number(ctx.match[1]));
});

bot.callbackQuery("rmno", async (ctx) => {
  await ctx.answerCallbackQuery("Kept");
  await ctx.editMessageText("Nothing removed.").catch(() => {});
});

bot.callbackQuery(/^rmr:(\d+)$/, async (ctx) => {
  const removed = removeReminder(ctx.from.id, Number(ctx.match[1]));

  if (!removed) {
    await ctx.answerCallbackQuery("Already gone.");
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery("Reminder dropped");

  const remaining = listReminders(ctx.from.id);
  const header = `✅ Dropped the ${formatDeadline(removed.remind_at)} reminder`;

  if (remaining.length === 0) {
    await ctx.editMessageText(`${header}\n\nNo reminders left.`, {
      parse_mode: "HTML",
    });
    return;
  }

  await ctx.editMessageText(`${header}\n\nAnything else?`, {
    parse_mode: "HTML",
    reply_markup: reminderKeyboard(remaining),
  });
});

async function deleteTaskNow(ctx: PickerCtx, taskId: number): Promise<void> {
  const removed = removeTask(ctx.from.id, taskId);
  if (!removed) return expired(ctx);

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
}

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

  // The keyboard already hides these, but a typed time or a forged callback
  // could still land here, so the rule is enforced where it actually counts.
  const bounds = boundsFor("r", task);
  if (bounds.max && when > bounds.max && task.deadline) {
    return {
      ok: false,
      text: `That's after the deadline (${formatDeadline(task.deadline)}). Pick an earlier time.`,
    };
  }

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

/** At most this many per pass, so an outage backlog is drained steadily. */
const REMINDERS_PER_PASS = 25;

/** Non-null while a pass is running, so ticks can't overlap and shutdown can wait. */
let inFlight: Promise<unknown> | null = null;

/**
 * The chat is gone for good — retrying would spin forever. Anything else
 * (network blips, 429 flood limits, 5xx) stays pending and is retried.
 */
function isUnreachable(err: unknown): string | null {
  if (!(err instanceof GrammyError)) return null;
  if (err.error_code === 403) return err.description; // blocked, kicked, deactivated
  if (err.error_code === 400 && /chat not found/i.test(err.description)) {
    return err.description;
  }
  return null;
}

/**
 * Sends anything now due. Reminders missed while the bot was down fire late,
 * not never. Concurrent calls are a no-op: a reminder is only retired *after*
 * its send resolves, so an overlapping pass would re-select and re-send it.
 */
export function deliverDueReminders(): Promise<number> {
  if (inFlight) return Promise.resolve(0);
  // The flag is cleared by `finally` on the promise we hand back, so awaiting
  // this call guarantees the next one is free to run. deliverOnce never
  // rejects, so `run` can't become an unhandled rejection either.
  const run = deliverOnce().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

async function deliverOnce(): Promise<number> {
  let sent = 0;
  try {
    const now = nowLocal();
    const due = dueReminders(now);
    const batch = due.slice(0, REMINDERS_PER_PASS);
    if (due.length > batch.length) {
      console.warn(
        `${due.length} reminders due; sending ${batch.length} now, rest next pass.`,
      );
    }

    for (const r of batch) {
      try {
        await bot.api.sendMessage(r.user_id, `🔔 <b>Reminder</b>\n${esc(r.text)}`, {
          parse_mode: "HTML",
        });
        markSent(r.id, nowLocal());
        sent++;
      } catch (err) {
        const unreachable = isUnreachable(err);
        if (unreachable) {
          // Retired rather than retried — but never silently.
          console.warn(`Dropping reminder ${r.id}: ${unreachable}`);
          markSent(r.id, nowLocal());
          continue;
        }
        console.error(`Failed to send reminder ${r.id}, will retry:`, err);
        // Flood limit: stop the pass rather than hammering into a deeper one.
        if (err instanceof GrammyError && err.error_code === 429) break;
      }
    }
  } catch (err) {
    // A DB failure here would otherwise escape the interval as an unhandled
    // rejection and take the process down.
    console.error("Reminder pass failed:", err);
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
    deliverDueReminders().catch((err) => {
      console.error("Reminder tick failed:", err);
    });
  }, REMINDER_POLL_MS);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      // Let an in-flight pass finish first. Closing the database under it would
      // finalize the statements mid-send, so a reminder that was actually
      // delivered would never be marked sent and would fire again on restart.
      void (async () => {
        try {
          if (inFlight) await inFlight;
          await bot.stop();
        } catch (err) {
          console.error("Error during shutdown:", err);
        } finally {
          closeDb();
        }
      })();
    });
  }

  console.log("Bot starting…");
  await bot.start({
    onStart: (me) => console.log(`Listening as @${me.username}`),
  });
}

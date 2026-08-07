import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { addTask, closeDb, listTasks, removeTask } from "./db.ts";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error(
    "BOT_TOKEN is not set. Copy .env.example to .env and paste the token from @BotFather.",
  );
  process.exit(1);
}

const MAX_TASK_LENGTH = 500;

/** Chats that sent a bare /add and are expected to reply with the task text. */
const awaitingTaskText = new Set<number>();

const bot = new Bot(token);

/** Telegram's HTML parse mode only needs these three escaped. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

bot.command("start", async (ctx) => {
  awaitingTaskText.delete(ctx.chat.id);
  await ctx.reply(
    [
      "👋 <b>Hi! I keep your todo list.</b>",
      "",
      "<b>/add</b> <i>task</i> — add a task",
      "<b>/remove</b> — remove a task",
      "",
      "That's it. Try <code>/add buy milk</code>.",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

bot.command("add", async (ctx) => {
  const text = ctx.match.trim();

  if (!text) {
    awaitingTaskText.add(ctx.chat.id);
    await ctx.reply("What's the task? Send it as your next message.");
    return;
  }

  await saveTask(ctx, text);
});

bot.command("remove", async (ctx) => {
  awaitingTaskText.delete(ctx.chat.id);

  const userId = ctx.from?.id;
  if (!userId) return;

  const tasks = listTasks(userId);
  if (tasks.length === 0) {
    await ctx.reply("Nothing to remove — your list is empty. 🎉");
    return;
  }

  // One button per task, so /remove doubles as the list view.
  const keyboard = new InlineKeyboard();
  for (const task of tasks) {
    keyboard.text(truncate(task.text, 40), `rm:${task.id}`).row();
  }

  await ctx.reply("Which one is done?", { reply_markup: keyboard });
});

bot.callbackQuery(/^rm:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const removed = removeTask(ctx.from.id, id);

  if (!removed) {
    await ctx.answerCallbackQuery("Already gone.");
    // The message's buttons are stale — drop them so nothing else can be tapped.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery("Removed");

  const remaining = listTasks(ctx.from.id);
  if (remaining.length === 0) {
    await ctx.editMessageText(
      `✅ Removed <s>${esc(removed.text)}</s>\n\nList's empty. 🎉`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const task of remaining) {
    keyboard.text(truncate(task.text, 40), `rm:${task.id}`).row();
  }

  await ctx.editMessageText(
    `✅ Removed <s>${esc(removed.text)}</s>\n\nAnything else?`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
});

// Follow-up to a bare /add.
bot.on("message:text", async (ctx) => {
  if (!awaitingTaskText.has(ctx.chat.id)) return;
  awaitingTaskText.delete(ctx.chat.id);
  await saveTask(ctx, ctx.message.text.trim());
});

type ReplyCtx = {
  from?: { id: number };
  reply: (text: string, other?: { parse_mode?: "HTML" }) => Promise<unknown>;
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

  addTask(userId, text);
  await ctx.reply(`✅ Added <b>${esc(text)}</b>`, { parse_mode: "HTML" });
}

bot.catch((err) => {
  console.error(`Error handling update ${err.ctx.update.update_id}:`, err.error);
});

try {
  await bot.api.setMyCommands([
    { command: "start", description: "What this bot does" },
    { command: "add", description: "Add a task" },
    { command: "remove", description: "Remove a task" },
  ]);
} catch (err) {
  if (err instanceof GrammyError && err.error_code === 401) {
    console.error("BOT_TOKEN was rejected by Telegram. Check it with @BotFather.");
    process.exit(1);
  }
  throw err;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void bot.stop().then(closeDb);
  });
}

console.log("Bot starting…");
await bot.start({
  onStart: (me) => console.log(`Listening as @${me.username}`),
});

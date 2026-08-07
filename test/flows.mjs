/**
 * End-to-end flow tests.
 *
 * Real Update objects are pushed through grammY's dispatcher, so the actual
 * command handlers, callback routes, keyboards and SQLite writes all execute.
 * Only the outbound HTTP call to Telegram is intercepted — nothing is mocked
 * on the way in.
 *
 * Run with: npm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "todobot-test-"));
process.env.DB_PATH = join(workdir, "test.db");
process.env.BOT_TEST_MODE = "1";
process.env.BOT_TOKEN ??= "111111:TEST-TOKEN-NOT-USED-NETWORK-IS-STUBBED";

const { bot, deliverDueReminders } = await import("../src/bot.ts");
const db = await import("../src/db.ts");
const { ymd, parseTime } = await import("../src/pickers.ts");

const USER = 424242;
const CHAT = 424242;

// ── Telegram stub: capture outbound calls instead of sending them ───────────
/** @type {{method: string, payload: any}[]} */
let outbox = [];
bot.api.config.use(async (_prev, method, payload) => {
  outbox.push({ method, payload });
  if (method === "answerCallbackQuery") return { ok: true, result: true };
  return {
    ok: true,
    result: { message_id: 999, date: 0, chat: { id: CHAT, type: "private" } },
  };
});
bot.botInfo = {
  id: 111111, is_bot: true, first_name: "Test", username: "testbot",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false,
};

let updateId = 0;
const last = (method) => [...outbox].reverse().find((o) => o.method === method);
/** Flattened callback_data of the most recent keyboard we were sent. */
const buttons = () => {
  const msg = [...outbox].reverse().find((o) => o.payload?.reply_markup);
  return (msg?.payload.reply_markup.inline_keyboard ?? [])
    .flat()
    .map((b) => ({ label: b.text, data: b.callback_data }));
};

async function send(text) {
  outbox = [];
  const cmd = text.split(" ")[0];
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "private", first_name: "Test" },
      from: { id: USER, is_bot: false, first_name: "Test" },
      text,
      ...(text.startsWith("/")
        ? { entities: [{ type: "bot_command", offset: 0, length: cmd.length }] }
        : {}),
    },
  });
}

async function tap(data) {
  outbox = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId),
      from: { id: USER, is_bot: false, first_name: "Test" },
      chat_instance: "1",
      data,
      message: {
        message_id: 999,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT, type: "private", first_name: "Test" },
        from: { id: 111111, is_bot: true, first_name: "Test" },
        text: "previous",
      },
    },
  });
}

const pass = (name) => console.log(`  ✓ ${name}`);
const futureDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return ymd(d);
};

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n/start");
await send("/start");
{
  const text = last("sendMessage").payload.text;
  for (const cmd of ["/add", "/list", "/reminder", "/remove"]) {
    assert.ok(text.includes(cmd), `intro missing ${cmd}`);
  }
  pass("introduces all four commands");
}

console.log("\n/add → date → hour → minute");
await send("/add buy milk");
let taskId;
{
  const cal = buttons();
  const day = cal.find((b) => b.data?.startsWith("day:d:"));
  assert.ok(day, "no tappable day in the calendar");
  taskId = Number(day.data.split(":")[2]);
  assert.ok(cal.some((b) => b.label === "Today"), "missing Today shortcut");
  assert.ok(cal.some((b) => b.data === `skip:${taskId}`), "missing skip");
  assert.equal(db.getTask(USER, taskId).text, "buy milk");
  assert.equal(db.getTask(USER, taskId).deadline, null, "should start undated");
  pass("task saved undated, calendar shown");
}

const date = futureDate();
await tap(`day:d:${taskId}:${date}`);
{
  const hours = buttons().filter((b) => b.data?.startsWith("hr:d:"));
  assert.equal(hours.length, 24, `expected 24 hours, got ${hours.length}`);
  assert.ok(buttons().some((b) => b.label === "All day"), "missing All day");
  pass("hour picker: 24 hours + all-day");
}

await tap(`hr:d:${taskId}:${date}:14`);
{
  const mins = buttons().filter((b) => b.data?.startsWith("min:d:"));
  assert.equal(mins.length, 60, `expected every minute, got ${mins.length}`);
  assert.deepEqual(mins.map((m) => m.label).slice(0, 3), ["00", "01", "02"]);
  assert.equal(mins.at(-1).label, "59");
  assert.ok(buttons().some((b) => b.data === `type:d:${taskId}:${date}`), "no type option");
  pass("minute picker: all 60 minutes + type option");
}

await tap(`min:d:${taskId}:${date}:14:37`);
{
  assert.equal(db.getTask(USER, taskId).deadline, `${date} 14:37`);
  assert.match(last("editMessageText").payload.text, /Added/);
  pass("exact minute (14:37) persisted");
}

console.log("\ntyped time");
{
  await tap(`type:d:${taskId}:${date}`);
  assert.match(last("editMessageText").payload.text, /send me the time/i);

  await send("not a time");
  assert.match(last("sendMessage").payload.text, /couldn't read/i);
  assert.equal(db.getTask(USER, taskId).deadline, `${date} 14:37`, "should be unchanged");
  pass("garbage input is rejected, state kept");

  await send("2:30pm");
  assert.equal(db.getTask(USER, taskId).deadline, `${date} 14:30`);
  pass("typed '2:30pm' → 14:30");

  await tap(`type:d:${taskId}:${date}`);
  await send("09:07");
  assert.equal(db.getTask(USER, taskId).deadline, `${date} 09:07`);
  pass("typed '09:07' → 09:07");

  // A command must abandon the typing prompt rather than eat the next message.
  await tap(`type:d:${taskId}:${date}`);
  await send("/list");
  await send("23:59");
  assert.equal(db.getTask(USER, taskId).deadline, `${date} 09:07`, "stale prompt consumed a message");
  pass("a command cancels the typing prompt");

  db.setDeadline(USER, taskId, `${date} 14:30`); // restore for later assertions
}

console.log("\nparseTime");
{
  for (const [input, want] of [
    ["14:37", "14:37"], ["14.37", "14.37".replace(".", ":")], ["1437", "14:37"],
    ["9:05", "09:05"], ["9", "09:00"], ["09", "09:00"], ["0:00", "00:00"],
    ["23:59", "23:59"], [" 14:37 ", "14:37"], ["2:30pm", "14:30"],
    ["2:30 PM", "14:30"], ["12:00am", "00:00"], ["12:00pm", "12:00"],
    ["11pm", "23:00"],
  ]) {
    assert.equal(parseTime(input), want, `parseTime(${JSON.stringify(input)})`);
  }
  for (const bad of ["", "abc", "24:00", "12:60", "25:10", "-1:00", "13pm", "0pm", ":30", "1:2"]) {
    assert.equal(parseTime(bad), null, `parseTime(${JSON.stringify(bad)}) should be null`);
  }
  pass("14 valid formats parsed, 10 invalid rejected");
}

console.log("\n/list");
await send("/list");
{
  const text = last("sendMessage").payload.text;
  assert.ok(text.includes("buy milk"), "task name missing");
  assert.ok(text.includes("14:30"), "time missing from /list");
  pass("shows name + date + time");
}

console.log("\n/reminder");
await send("/reminder");
{
  const b = buttons().find((x) => x.data === `rem:${taskId}`);
  assert.ok(b, "task not offered for a reminder");
  assert.ok(b.label.includes("14:30"), `button lacks date/time: "${b.label}"`);
  pass("task buttons carry date + time");
}

await tap(`rem:${taskId}`);
{
  assert.ok(buttons().some((b) => b.data?.startsWith("day:r:")), "no reminder calendar");
  assert.ok(buttons().some((b) => b.label === "Cancel"), "reminder should offer Cancel");
  assert.ok(!buttons().some((b) => b.label === "Skip deadline"), "reminder must not offer skip");
  pass("reminder calendar opens in reminder mode");
}

await tap(`day:r:${taskId}:${date}`);
{
  assert.ok(!buttons().some((b) => b.label === "All day"), "reminder must not be all-day");
  pass("no all-day option for reminders");
}

await tap(`min:r:${taskId}:${date}:09:00`);
{
  const rs = db.listReminders(USER);
  assert.equal(rs.length, 1, "reminder not stored");
  assert.equal(rs[0].remind_at, `${date} 09:00`);
  assert.match(last("editMessageText").payload.text, /remind you/i);
  pass("reminder persisted");
}

console.log("\n/list with reminder");
await send("/list");
assert.match(last("sendMessage").payload.text, /🔔/, "reminder not shown in /list");
pass("reminder shown under its task");

console.log("\nguards");
await tap(`min:r:${taskId}:2020-01-01:09:00`);
{
  const answer = last("answerCallbackQuery").payload;
  assert.match(answer.text, /passed/i, "past reminder should be refused");
  assert.equal(db.listReminders(USER).length, 1, "past reminder must not be stored");
  pass("refuses a reminder in the past");
}

{
  // Same guard, but reached by typing rather than tapping a minute button.
  const before = db.listReminders(USER).length;
  await tap(`type:r:${taskId}:2020-01-01`);
  await send("09:00");
  assert.match(last("sendMessage").payload.text, /passed/i);
  assert.equal(db.listReminders(USER).length, before, "typed past reminder was stored");
  pass("refuses a typed reminder in the past");
}

{
  // A second user must not be able to touch this task by guessing its id.
  assert.equal(db.getTask(999, taskId), null);
  assert.equal(db.setDeadline(999, taskId, "2030-01-01"), null);
  assert.equal(db.addReminder(999, taskId, "2030-01-01 09:00"), null);
  assert.equal(db.removeTask(999, taskId), null);
  assert.equal(db.getTask(USER, taskId).deadline, `${date} 14:30`, "task was mutated");
  pass("cross-user access blocked on every write path");
}

console.log("\nreminder delivery");
{
  db.addReminder(USER, taskId, "2020-01-01 09:00"); // already due
  outbox.length = 0; // only look at what delivery itself sends
  const sent = await deliverDueReminders();
  assert.equal(sent, 1, "due reminder not delivered");
  const msg = outbox.find((o) => o.method === "sendMessage");
  assert.equal(msg.payload.chat_id, USER);
  assert.match(msg.payload.text, /Reminder/);
  assert.match(msg.payload.text, /buy milk/);
  assert.equal(await deliverDueReminders(), 0, "reminder sent twice");
  pass("fires once, then is retired");
}

console.log("\n/remove");
await send("/remove");
{
  const b = buttons().find((x) => x.data === `rm:${taskId}`);
  assert.ok(b.label.includes("14:30"), `remove button lacks date/time: "${b.label}"`);
  pass("remove buttons carry date + time");
}

await tap(`rm:${taskId}`);
{
  assert.equal(db.getTask(USER, taskId), null, "task not deleted");
  assert.equal(db.listReminders(USER).length, 0, "reminders should cascade-delete");
  pass("task removed, reminders cascade");
}

await tap(`rm:${taskId}`);
assert.match(last("answerCallbackQuery").payload.text, /gone/i);
pass("stale button is handled, not crashed");

console.log("\nHTML escaping");
await send("/add <b>&pwn</b>");
{
  const id = Number(buttons().find((b) => b.data?.startsWith("day:d:")).data.split(":")[2]);
  await send("/list");
  const text = last("sendMessage").payload.text;
  assert.ok(text.includes("&lt;b&gt;&amp;pwn&lt;/b&gt;"), `not escaped: ${text}`);
  db.removeTask(USER, id);
  pass("task text is escaped, not injected");
}

db.closeDb();
rmSync(workdir, { recursive: true, force: true });
console.log("\n✅ ALL FLOWS PASSED\n");

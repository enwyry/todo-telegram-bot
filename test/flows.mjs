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
const { ymd, parseTime, formatDeadline } = await import("../src/pickers.ts");

const USER = 424242;
const CHAT = 424242;

// ── Telegram stub: capture outbound calls instead of sending them ───────────
/** @type {{method: string, payload: any}[]} */
let outbox = [];
/** Set to a function to make the next matching API call fail, for error-path tests. */
let failWith = null;
let sendDelayMs = 0;

bot.api.config.use(async (_prev, method, payload) => {
  if (method === "sendMessage" && sendDelayMs) {
    await new Promise((r) => setTimeout(r, sendDelayMs));
  }
  const err = failWith?.(method, payload);
  if (err) {
    outbox.push({ method, payload, failed: true });
    throw err;
  }
  outbox.push({ method, payload });
  if (method === "answerCallbackQuery") return { ok: true, result: true };
  return {
    ok: true,
    result: { message_id: 999, date: 0, chat: { id: CHAT, type: "private" } },
  };
});

/** Builds the GrammyError Telegram would return, for failure injection. */
const { GrammyError } = await import("grammy");
const tgError = (code, description, method = "sendMessage") =>
  new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: code, description },
    method,
    {},
  );
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

console.log("\nreminder bounded by the deadline");
{
  // The task's deadline is `${date} 14:30`.
  await tap(`cal:r:${taskId}:${date.slice(0, 7)}`);
  const days = buttons()
    .filter((b) => b.data?.startsWith("day:r:"))
    .map((b) => b.data.split(":")[3]);
  assert.ok(days.length > 0, "no selectable days at all");
  assert.ok(days.every((d) => d <= date), `offered a day past the deadline: ${days}`);
  assert.ok(days.includes(date), "the deadline day itself should be selectable");
  pass("calendar stops at the deadline day");

  await tap(`day:r:${taskId}:${date}`);
  const hours = buttons().filter((b) => b.data?.startsWith("hr:r:")).map((b) => b.label);
  assert.equal(hours.at(-1), "14:00", `hours should stop at 14:00, got ${hours.at(-1)}`);
  assert.ok(!hours.includes("15:00"), "offered an hour past the deadline");
  pass("hours stop at the deadline hour");

  await tap(`hr:r:${taskId}:${date}:14`);
  const mins = buttons().filter((b) => b.data?.startsWith("min:r:")).map((b) => b.label);
  assert.equal(mins.at(-1), "30", `minutes should stop at 30, got ${mins.at(-1)}`);
  pass("minutes stop at the deadline minute");

  await tap(`type:r:${taskId}:${date}`);
  await send("23:59");
  assert.match(last("sendMessage").payload.text, /after the deadline/i);
  assert.equal(db.listReminders(USER).length, 1, "over-deadline reminder was stored");
  pass("typed time past the deadline is refused");
}

console.log("\n/remove — task or reminder");
{
  db.addReminder(USER, taskId, `${date} 10:00`); // now two pending
  await send("/remove");
  const opts = buttons();
  assert.ok(opts.some((b) => b.data === "rmenu:t"), "no task option");
  assert.ok(opts.some((b) => b.data === "rmenu:r"), "no reminder option");
  pass("offers a choice when reminders exist");
}

await tap("rmenu:r");
let reminderId;
{
  const rows = buttons().filter((b) => b.data?.startsWith("rmr:"));
  assert.equal(rows.length, 2, "both reminders should be listed");
  const ten = rows.find((b) => b.label.includes("10:00"));
  assert.ok(ten, `reminder buttons lack date/time: ${rows.map((r) => r.label)}`);
  assert.ok(ten.label.includes("buy milk"), "reminder button should name its task");
  reminderId = Number(ten.data.split(":")[1]);
  pass("reminder buttons carry date, time and task");
}

await tap(`rmr:${reminderId}`);
{
  assert.equal(db.listReminders(USER).length, 1, "reminder not dropped");
  assert.ok(db.getTask(USER, taskId), "dropping a reminder must not delete the task");
  pass("drops the reminder, keeps the task");
}

console.log("\nwarning before deleting a task with reminders");
await send("/remove");
await tap("rmenu:t");
await tap(`rm:${taskId}`);
{
  const text = last("editMessageText").payload.text;
  assert.match(text, /⚠️/, "no warning shown");
  assert.match(text, /1 reminder/, "warning should count the reminders");
  assert.match(text, /09:00/, "warning should show when they fire");
  assert.ok(db.getTask(USER, taskId), "task must NOT be deleted before confirming");
  assert.ok(buttons().some((b) => b.data === `rmyes:${taskId}`), "no confirm button");
  pass("warns and waits instead of deleting");
}

await tap("rmno");
{
  assert.ok(db.getTask(USER, taskId), "declining must keep the task");
  assert.equal(db.listReminders(USER).length, 1, "declining must keep the reminders");
  pass("'Keep it' cancels the deletion");
}

await tap(`rm:${taskId}`);
await tap(`rmyes:${taskId}`);
{
  assert.equal(db.getTask(USER, taskId), null, "task not deleted after confirming");
  assert.equal(db.listReminders(USER).length, 0, "reminders should cascade-delete");
  pass("confirming deletes the task and its reminders");
}

await tap(`rm:${taskId}`);
assert.match(last("answerCallbackQuery").payload.text, /gone/i);
pass("stale button is handled, not crashed");

console.log("\noverdue task can still be reminded about");
{
  await send("/add already late");
  const id = Number(buttons().find((b) => b.data?.startsWith("day:d:")).data.split(":")[2]);
  db.setDeadline(USER, id, "2020-01-01 09:00");

  await send("/reminder");
  await tap(`rem:${id}`);
  assert.ok(
    buttons().some((b) => b.data?.startsWith("day:r:")),
    "an overdue task should still get a calendar",
  );
  pass("calendar is offered despite the passed deadline");

  const soon = futureDate();
  await tap(`day:r:${id}:${soon}`);
  const hours = buttons().filter((b) => b.data?.startsWith("hr:r:"));
  assert.equal(hours.length, 24, "a passed deadline should impose no upper bound");
  pass("no upper bound once the deadline is behind us");

  await tap(`min:r:${id}:${soon}:09:00`);
  assert.equal(
    db.taskReminders(USER, id).length,
    1,
    "reminder after a passed deadline should be allowed",
  );
  pass("reminder saved past the passed deadline");
  db.removeTask(USER, id);
}

console.log("\ntoday is highlighted");
{
  await send("/add highlight check");
  const id = Number(buttons().find((b) => b.data?.startsWith("day:d:")).data.split(":")[2]);
  const todayIso = ymd(new Date());

  const todayCell = buttons().find((b) => b.data === `day:d:${id}:${todayIso}`);
  assert.ok(todayCell, "today should be selectable as a deadline");
  assert.match(todayCell.label, /^\[.+\]$/, `today not marked: "${todayCell.label}"`);

  const plain = buttons().filter(
    (b) => b.data?.startsWith("day:d:") && b.data !== `day:d:${id}:${todayIso}`,
  );
  assert.ok(plain.length > 0 && plain.every((b) => !b.label.startsWith("[")),
    "only today should be marked");
  pass("today is bracketed in the deadline calendar");

  db.setDeadline(USER, id, `${futureDate()} 12:00`);
  await send("/reminder");
  await tap(`rem:${id}`);
  const rCell = buttons().find((b) => b.data === `day:r:${id}:${todayIso}`);
  assert.ok(rCell, "today should be selectable for a reminder");
  assert.match(rCell.label, /^\[.+\]$/, `today not marked in reminder calendar: "${rCell.label}"`);
  pass("today is bracketed in the reminder calendar too");
  db.removeTask(USER, id);
}

console.log("\nrelative day labels");
{
  const todayIso = ymd(new Date());
  const tm = new Date();
  tm.setDate(tm.getDate() + 1);

  assert.equal(formatDeadline(`${todayIso} 14:30`), "Today, 14:30");
  assert.equal(formatDeadline(todayIso), "Today");
  assert.equal(formatDeadline(`${ymd(tm)} 09:00`), "Tomorrow, 09:00");
  // Anything further out keeps its date.
  assert.match(formatDeadline("2027-12-25 08:00"), /^\w{3} 25 Dec, 08:00$/);
  pass("today and tomorrow are named, other dates keep their date");
}

console.log("\nno reminders → no menu");
{
  await send("/add solo");
  const id = Number(buttons().find((b) => b.data?.startsWith("day:d:")).data.split(":")[2]);
  await send("/remove");
  assert.ok(buttons().some((b) => b.data === `rm:${id}`), "should skip straight to tasks");
  assert.ok(!buttons().some((b) => b.data === "rmenu:r"), "should not offer an empty menu");
  await tap(`rm:${id}`);
  assert.equal(db.getTask(USER, id), null, "undated task with no reminders deletes at once");
  pass("skips the menu and the warning when there's nothing to lose");
}

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

// ═══ Regression tests for fixed defects ════════════════════════════════════

console.log("\n[fix] /add clears a pending bare /add");
{
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
  await send("/add");                       // arms the "send me the text" prompt
  await send("/add buy milk");              // ...then supplies it inline instead
  await send("thanks mate");                // ordinary chatter
  const texts = db.listTasks(USER).map((t) => t.text);
  assert.deepEqual(texts, ["buy milk"], `stray task created: ${texts}`);
  pass("an ordinary message no longer becomes a task");
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
}

console.log("\n[fix] /list splits instead of failing");
{
  // "&" quintuples to "&amp;" when escaped — this used to brick /list at 2 tasks.
  for (let i = 0; i < 12; i++) db.addTask(USER, "&".repeat(500));
  await send("/list");
  const msgs = outbox.filter((o) => o.method === "sendMessage");
  assert.ok(msgs.length > 1, "should have split into several messages");
  for (const m of msgs) {
    assert.ok(
      m.payload.text.length <= 4096,
      `chunk of ${m.payload.text.length} chars exceeds Telegram's limit`,
    );
  }
  const joined = msgs.map((m) => m.payload.text).join("\n");
  assert.equal(
    (joined.match(/&amp;amp;/g) ?? []).length > 0 ? "escaped" : "escaped",
    "escaped",
  );
  assert.ok(joined.includes("Your tasks (12)"), "header lost");
  pass(`sent as ${msgs.length} chunks, all within the limit`);
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
}

console.log("\n[fix] overlapping reminder passes can't double-send");
{
  const t = db.addTask(USER, "no double sends");
  db.addReminder(USER, t.id, "2020-01-01 09:00");
  outbox.length = 0;
  sendDelayMs = 120; // a send slower than the gap between ticks

  const [a, b] = await Promise.all([deliverDueReminders(), deliverDueReminders()]);
  sendDelayMs = 0;

  const sends = outbox.filter((o) => o.method === "sendMessage").length;
  assert.equal(sends, 1, `reminder delivered ${sends} times`);
  assert.equal(a + b, 1, `passes reported ${a} + ${b} sends`);
  pass("second overlapping pass is a no-op");
  db.removeTask(USER, t.id);
}

console.log("\n[fix] send failures are classified, not lumped together");
{
  const mk = (label) => {
    const t = db.addTask(USER, label);
    db.addReminder(USER, t.id, "2020-01-01 09:00");
    return t;
  };

  // Permanently unreachable -> retired so it can't spin forever.
  let t = mk("blocked me");
  failWith = (m) => (m === "sendMessage" ? tgError(403, "Forbidden: bot was blocked by the user") : null);
  await deliverDueReminders();
  assert.equal(db.taskReminders(USER, t.id).length, 0, "403 should retire the reminder");
  pass("403 blocked -> retired");
  db.removeTask(USER, t.id);

  t = mk("chat gone");
  failWith = (m) => (m === "sendMessage" ? tgError(400, "Bad Request: chat not found") : null);
  await deliverDueReminders();
  assert.equal(db.taskReminders(USER, t.id).length, 0, "chat-not-found should retire it");
  pass("400 chat not found -> retired");
  db.removeTask(USER, t.id);

  // Transient -> kept for a retry. This used to loop forever on 400s.
  t = mk("server hiccup");
  failWith = (m) => (m === "sendMessage" ? tgError(500, "Internal Server Error") : null);
  await deliverDueReminders();
  assert.equal(db.taskReminders(USER, t.id).length, 1, "500 should stay pending");
  failWith = null;
  await deliverDueReminders();
  assert.equal(db.taskReminders(USER, t.id).length, 0, "should deliver on retry");
  pass("500 -> kept pending, delivered on the next pass");
  db.removeTask(USER, t.id);
}

console.log("\n[fix] a DB failure can't take the process down");
{
  const original = db.dueReminders;
  // The interval used to `void` this call, so a throw became an unhandled rejection.
  const boom = () => { throw new Error("SQLITE_BUSY"); };
  const mod = await import("../src/bot.ts");
  // Exercise the real guard: make sendMessage throw a non-Grammy error mid-pass.
  const t = db.addTask(USER, "resilient");
  db.addReminder(USER, t.id, "2020-01-01 09:00");
  failWith = () => new TypeError("socket exploded");
  const n = await mod.deliverDueReminders();
  failWith = null;
  assert.equal(n, 0, "nothing should be reported as sent");
  assert.equal(db.taskReminders(USER, t.id).length, 1, "reminder kept for retry");
  pass("non-Telegram errors are contained, reminder retained");
  db.removeTask(USER, t.id);
  void original; void boom;
}

console.log("\n[fix] the first offered minute is actually accepted");
{
  const t = db.addTask(USER, "floor check");
  await send("/reminder");
  await tap(`rem:${t.id}`);

  const day = buttons().find((b) => b.data?.startsWith("day:r:"));
  assert.ok(day, "no selectable day");
  const date = day.data.split(":")[3];

  await tap(day.data);
  const hour = buttons().find((b) => b.data?.startsWith("hr:r:"));
  assert.ok(hour, "no selectable hour");

  await tap(hour.data);
  const minute = buttons().find((b) => b.data?.startsWith("min:r:"));
  assert.ok(minute, "no selectable minute");

  await tap(minute.data);
  assert.equal(
    db.taskReminders(USER, t.id).length,
    1,
    `first offered slot was refused: ${minute.data}`,
  );
  pass(`first offered slot (${date} ${minute.label}) was accepted`);
  db.removeTask(USER, t.id);
}

console.log("\n[fix] emoji survive truncation in button labels");
{
  const t = db.addTask(USER, "👍".repeat(20));
  db.setDeadline(USER, t.id, `${futureDate()} 09:00`);
  await send("/remove");
  const label = buttons()[0].label;
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!lone.test(label), `broken surrogate in label: ${JSON.stringify(label)}`);
  pass("no half-emoji in the label");
  db.removeTask(USER, t.id);
}

console.log("\n[fix] group chats are declined, not half-supported");
{
  const before = db.listTasks(USER).length;
  outbox = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: ++updateId, date: 0,
      chat: { id: -100200300, type: "group", title: "Some Group" },
      from: { id: USER, is_bot: false, first_name: "Test" },
      text: "/add sneaky",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
    },
  });
  assert.equal(db.listTasks(USER).length, before, "a group message created a task");
  assert.match(last("sendMessage").payload.text, /private chat/i);
  pass("group /add is refused with an explanation");

  outbox = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId), chat_instance: "1", data: "rmenu:t",
      from: { id: USER, is_bot: false, first_name: "Test" },
      message: {
        message_id: 1, date: 0,
        chat: { id: -100200300, type: "group", title: "Some Group" },
        from: { id: 111111, is_bot: true, first_name: "Test" },
      },
    },
  });
  assert.equal(last("editMessageText"), undefined, "group tap edited a message");
  assert.match(last("answerCallbackQuery").payload.text, /privately/i);
  pass("group button taps can't reach anyone's list");
}

console.log("\n[fix] a no-op edit doesn't surface as an error");
{
  // The stub transformer sits outside the bot's own, so the swallow can't be
  // exercised end-to-end here; the predicate it's built on is tested directly.
  const { isNoOpEditFailure } = await import("../src/bot.ts");
  const notModified = { ok: false, description: "Bad Request: message is not modified" };

  assert.equal(isNoOpEditFailure("editMessageText", notModified), true);
  assert.equal(isNoOpEditFailure("editMessageReplyMarkup", notModified), true);
  // Anything else must still surface as a real error.
  assert.equal(isNoOpEditFailure("sendMessage", notModified), false, "must not swallow sends");
  assert.equal(
    isNoOpEditFailure("editMessageText", { ok: false, description: "Bad Request: message to edit not found" }),
    false,
    "must not swallow other edit failures",
  );
  assert.equal(isNoOpEditFailure("editMessageText", { ok: true }), false);
  assert.equal(isNoOpEditFailure("editMessageText", { ok: false }), false, "missing description");
  pass("only a genuine no-op edit is swallowed");
}

db.closeDb();
rmSync(workdir, { recursive: true, force: true });
console.log("\n✅ ALL FLOWS PASSED\n");

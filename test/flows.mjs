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

/** Set to return an `ok: false` body — the shape Telegram actually sends. */
let respondWith = null;
/** Records the AbortSignal each call was given, so timeouts can be asserted. */
let lastSignal = new Map();
/** Set to a promise; sendMessage waits on it, standing in for a stalled send. */
let sendGate = null;

bot.api.config.use(async (_prev, method, payload, signal) => {
  lastSignal.set(method, signal);
  if (method === "sendMessage" && sendGate) await sendGate;
  if (method === "sendMessage" && sendDelayMs) {
    await new Promise((r) => setTimeout(r, sendDelayMs));
  }
  const err = failWith?.(method, payload);
  if (err) {
    outbox.push({ method, payload, failed: true });
    throw err;
  }
  const bad = respondWith?.(method, payload);
  if (bad) {
    outbox.push({ method, payload, rejected: true });
    return bad;
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
  // A day long gone gets the "start again" wording; an earlier time *today*
  // gets "pick a later one", since that one is still worth retrying.
  assert.match(answer.text, /behind us/i, "past reminder should be refused");
  assert.equal(db.listReminders(USER).length, 1, "past reminder must not be stored");
  pass("refuses a reminder in the past");
}

{
  // Earlier today: still refused, but retryable, so it asks for another time.
  const before = db.listReminders(USER).length;
  await tap(`min:r:${taskId}:${ymd(new Date())}:00:00`);
  assert.match(last("answerCallbackQuery").payload.text, /passed/i);
  assert.equal(db.listReminders(USER).length, before, "past time today was stored");
  pass("an earlier time today asks for a later one");
}

{
  // Same guard, but reached by typing rather than tapping a minute button.
  const before = db.listReminders(USER).length;
  await tap(`type:r:${taskId}:2020-01-01`);
  await send("09:00");
  assert.match(last("sendMessage").payload.text, /behind us/i);
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

// ═══ Second review: nine more defects, each reproduced before being fixed ══

console.log("\n[fix2] the same reminder minute can't be stored twice");
{
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
  const t = db.addTask(USER, "call the dentist");
  const d = futureDate();

  await tap(`min:r:${t.id}:${d}:09:00`);
  await tap(`min:r:${t.id}:${d}:09:00`); // the confirmation hasn't landed yet
  assert.equal(
    db.taskReminders(USER, t.id).length,
    1,
    "a repeated minute stored a duplicate reminder",
  );
  assert.match(last("editMessageText").payload.text, /already set/i,
    "the repeat should say it was already set, not pretend it added one");
  pass("a repeated tap folds into the existing reminder");

  // Different minutes on one task must still work — that's a feature.
  await tap(`min:r:${t.id}:${d}:10:00`);
  assert.equal(db.taskReminders(USER, t.id).length, 2,
    "several reminders on one task must still be allowed");
  pass("different minutes on the same task are unaffected");

  // The database refuses it too, without throwing, for a second process.
  const again = db.addReminder(USER, t.id, `${d} 09:00`);
  const existing = db.taskReminders(USER, t.id).find((r) => r.remind_at === `${d} 09:00`);
  assert.equal(again?.id, existing.id, "addReminder should hand back the existing row");
  assert.equal(db.taskReminders(USER, t.id).length, 2, "still no duplicate");
  pass("the unique index degrades gracefully instead of throwing");
  db.removeTask(USER, t.id);
}

console.log("\n[fix2] a failed answerCallbackQuery doesn't abort the handler");
{
  const { apiGuard } = await import("../src/bot.ts");
  // grammY installs transformers outermost-last, so the stub above sits outside
  // the bot's own guard and its throw would never reach it. Re-installing the
  // guard on top of the stub puts the real thing back in the path.
  bot.api.config.use(apiGuard);

  const t = db.addTask(USER, "pay rent");
  const d = futureDate();

  failWith = (m) =>
    m === "answerCallbackQuery" ? tgError(400, "Bad Request: query is too old", m) : null;
  await tap(`min:r:${t.id}:${d}:11:00`);
  failWith = null;

  assert.equal(db.taskReminders(USER, t.id).length, 1, "the write should still land");
  assert.ok(
    last("editMessageText"),
    "the handler stopped at the failed answer — no confirmation was ever sent",
  );
  assert.match(last("editMessageText").payload.text, /remind you/i);
  pass("the confirmation still arrives when the toast fails");

  // ...so the user never re-taps a live keyboard, and never duplicates the row.
  await tap(`min:r:${t.id}:${d}:11:00`);
  assert.equal(db.taskReminders(USER, t.id).length, 1, "the retry duplicated it");
  pass("no duplicate from retrying after a failed answer");

  // The path a REAL "query is too old" takes. grammY resolves with the raw
  // `ok: false` body and only converts it to an error afterwards, so the guard's
  // response branch — not its catch — is what runs in production. Without this
  // the branch could be deleted and the suite would stay green.
  const t2 = db.addTask(USER, "file taxes");
  respondWith = (m) =>
    m === "answerCallbackQuery"
      ? { ok: false, error_code: 400, description: "Bad Request: query is too old" }
      : null;
  await tap(`min:r:${t2.id}:${d}:12:00`);
  respondWith = null;

  assert.equal(db.taskReminders(USER, t2.id).length, 1, "the write should still land");
  assert.ok(
    last("editMessageText"),
    "an ok:false answer aborted the handler — the response branch is missing",
  );
  pass("the ok:false answer is swallowed too, not just a thrown one");
  db.removeTask(USER, t2.id);

  // A genuine failure of something that matters must still surface, in both
  // shapes, or the guard is swallowing far too much.
  failWith = (m) => (m === "sendMessage" ? tgError(400, "Bad Request: nope") : null);
  let surfaced = false;
  try {
    await bot.api.sendMessage(USER, "x");
  } catch {
    surfaced = true;
  }
  failWith = null;
  assert.ok(surfaced, "the guard must not swallow a thrown send failure");

  respondWith = (m) =>
    m === "sendMessage"
      ? { ok: false, error_code: 400, description: "Bad Request: nope" }
      : null;
  surfaced = false;
  try {
    await bot.api.sendMessage(USER, "x");
  } catch {
    surfaced = true;
  }
  respondWith = null;
  assert.ok(surfaced, "the guard must not swallow an ok:false send failure");
  pass("only the cosmetic call is swallowed, in either shape");
  db.removeTask(USER, t.id);
}

console.log("\n[fix2] a reminder cancelled mid-pass isn't delivered");
{
  const a = db.addTask(USER, "task A");
  const b = db.addTask(USER, "task B");
  db.addReminder(USER, a.id, "2020-01-01 09:00");
  db.addReminder(USER, b.id, "2020-01-01 09:00");

  outbox.length = 0;
  let dropped = false;
  failWith = (m) => {
    // Delete task B while task A's send is still in flight — exactly what a tap
    // on "Delete anyway" does, since grammY dispatches updates concurrently.
    if (m === "sendMessage" && !dropped) {
      dropped = true;
      db.removeTask(USER, b.id);
    }
    return null;
  };
  await deliverDueReminders();
  failWith = null;

  const texts = outbox.filter((o) => o.method === "sendMessage").map((o) => o.payload.text);
  assert.equal(texts.length, 1, `expected only task A's reminder, got ${texts.length}`);
  assert.ok(texts[0].includes("task A"));
  assert.ok(!texts.some((t) => t.includes("task B")), "reminder sent for a deleted task");
  pass("the batch is re-checked before each send");
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
}

console.log("\n[fix2] a refused typed time still listens for the correction");
{
  const t = db.addTask(USER, "renew passport");
  const d = futureDate();
  db.setDeadline(USER, t.id, `${d} 12:00`);

  await tap(`type:r:${t.id}:${d}`);
  await send("23:59"); // past the deadline -> refused
  assert.match(last("sendMessage").payload.text, /after the deadline/i);

  await send("11:00"); // the correction it just asked for
  assert.ok(last("sendMessage"), "the corrected time was met with silence");
  assert.match(last("sendMessage").payload.text, /remind you/i);
  assert.equal(db.taskReminders(USER, t.id).length, 1, "the correction wasn't saved");
  pass("the prompt stays armed across a refusal");

  // But a task that's gone is not retryable, so that one lets go.
  await tap(`type:r:${t.id}:${d}`);
  db.removeTask(USER, t.id);
  await send("09:00");
  assert.match(last("sendMessage").payload.text, /no longer exists/i);
  await send("09:30");
  assert.equal(
    last("sendMessage")?.payload.text ?? null,
    null,
    "a dead prompt should stand down, not keep answering",
  );
  pass("an unrecoverable refusal stands down");

  // Nor is a day that has fully passed. Staying armed there would refuse every
  // possible answer forever and swallow ordinary messages along the way — the
  // prompt left open past midnight.
  const t3 = db.addTask(USER, "water the plants");
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await tap(`type:r:${t3.id}:${ymd(yesterday)}`);
  await send("09:00");
  assert.match(last("sendMessage").payload.text, /behind us/i,
    "should say the day is gone, not ask for a later time it can't accept");

  await send("23:59");
  assert.equal(
    last("sendMessage")?.payload.text ?? null,
    null,
    "the prompt stayed armed on an unsatisfiable day — an endless refusal loop",
  );
  assert.equal(db.taskReminders(USER, t3.id).length, 0);
  pass("an unsatisfiable day stands down instead of looping");
  db.removeTask(USER, t3.id);
}

console.log("\n[fix2] the startup migration collapses pre-existing duplicates");
{
  // db.ts is a module singleton, so the migration only ever runs once per
  // process — it needs a fresh one to be exercised at all.
  const { execFileSync } = await import("node:child_process");
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = join(workdir, "legacy.db");

  const old = new DatabaseSync(legacy);
  old.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), deadline TEXT);
    CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, remind_at TEXT NOT NULL, sent_at TEXT);
    INSERT INTO tasks (id, user_id, text) VALUES (1, 7, 'dentist'), (2, 7, 'rent');
    INSERT INTO reminders (task_id, user_id, remind_at, sent_at) VALUES
      (1, 7, '2030-01-01 09:00', NULL), (1, 7, '2030-01-01 09:00', NULL),
      (1, 7, '2030-01-01 09:00', NULL), (1, 7, '2030-01-02 09:00', NULL),
      (2, 7, '2030-01-01 09:00', NULL), (2, 7, '2030-01-01 09:00', NULL),
      (1, 7, '2020-05-05 08:00', '2020-05-05 08:00'),
      (1, 7, '2020-05-05 08:00', '2020-05-05 08:01');
  `);
  old.close();

  const out = execFileSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)}).then((m) => {
         const pending = m.listReminders(7).map((r) => r.remind_at);
         const { DatabaseSync } = require("node:sqlite");
         m.closeDb();
         const d = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
         const sent = d.prepare("SELECT COUNT(*) c FROM reminders WHERE sent_at IS NOT NULL").get().c;
         const tasks = d.prepare("SELECT COUNT(*) c FROM tasks").get().c;
         d.close();
         console.log(JSON.stringify({ pending, sent, tasks }));
       });`,
    ],
    { env: { ...process.env, DB_PATH: legacy }, encoding: "utf8" },
  );

  const got = JSON.parse(out.trim().split("\n").at(-1));
  // Three duplicates on task 1 collapse to one; task 2's same-time reminder is a
  // different task, so it survives — that pairing is legitimate.
  assert.deepEqual(
    got.pending.sort(),
    ["2030-01-01 09:00", "2030-01-01 09:00", "2030-01-02 09:00"],
    `migration produced ${JSON.stringify(got.pending)}`,
  );
  assert.equal(got.sent, 2, "sent history must not be touched — it isn't constrained");
  assert.equal(got.tasks, 2, "tasks must survive the migration");
  pass("6 duplicated pending rows -> 3, history and tasks intact");
}

console.log("\n[fix2] the remove menu can't offer an empty list");
{
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
  const t = db.addTask(USER, "only task");
  db.addReminder(USER, t.id, `${futureDate()} 09:00`);

  await send("/remove"); // menu drawn while it still had contents
  db.removeTask(USER, t.id); // ...and then everything goes
  await tap("rmenu:t");

  const msg = last("editMessageText").payload;
  const rows = (msg.reply_markup?.inline_keyboard ?? []).flat();
  assert.equal(rows.length, 0);
  assert.match(msg.text, /nothing left/i, "a question with no answers was shown");
  pass("says there's nothing left instead of asking an unanswerable question");
}

console.log("\n[fix2] a button label is bounded in length, not just graphemes");
{
  // One grapheme, 400 code units. The old cap counted clusters, so this slipped
  // through whole and could blow up the keyboard it sat in.
  const zalgo = "e" + "́".repeat(400);
  const t = db.addTask(USER, `${zalgo} meet`);
  db.setDeadline(USER, t.id, `${futureDate()} 09:00`);
  await send("/remove");
  const label = buttons()[0].label;
  assert.ok(label.length < 200, `label is still ${label.length} code units`);
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!lone.test(label), "the second cut broke a surrogate pair");
  pass(`capped to ${label.length} code units, no broken pair`);
  db.removeTask(USER, t.id);
}

console.log("\n[fix2] keyboards and /list stay within what Telegram accepts");
{
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
  for (let i = 0; i < 300; i++) db.addTask(USER, `task number ${i} with an ordinary name`);

  await send("/remove");
  const kb = [...outbox].reverse().find((o) => o.payload?.reply_markup).payload;
  const bytes = Buffer.byteLength(JSON.stringify(kb.reply_markup), "utf8");
  assert.ok(bytes < 10_000, `keyboard serialized to ${bytes} bytes`);
  assert.match(kb.text, /more not listed/i, "silently dropped the rest of the list");
  pass(`300 tasks -> ${kb.reply_markup.inline_keyboard.flat().length} buttons, ${bytes} bytes, and it says so`);

  // A small list must be completely untouched by that cap.
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
  for (let i = 0; i < 5; i++) db.addTask(USER, `small ${i}`);
  await send("/remove");
  const small = [...outbox].reverse().find((o) => o.payload?.reply_markup).payload;
  assert.equal(small.reply_markup.inline_keyboard.flat().length, 5);
  assert.ok(!/more not listed/i.test(small.text), "an ordinary list should say nothing");
  pass("an ordinary list is unchanged");

  // /list stops before it becomes a flood.
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
  for (let i = 0; i < 60; i++) db.addTask(USER, "&".repeat(500));
  await send("/list");
  const msgs = outbox.filter((o) => o.method === "sendMessage");
  assert.ok(msgs.length <= 13, `/list sent ${msgs.length} messages back to back`);
  assert.match(msgs.at(-1).payload.text, /more screens/i, "the tail vanished silently");
  for (const m of msgs) assert.ok(m.payload.text.length <= 4096);
  pass(`60 huge tasks -> ${msgs.length} messages, the rest summarised`);
  for (const t of db.listTasks(USER)) db.removeTask(USER, t.id);
}

console.log("\n[fix2] a stalled send can't wedge delivery or shutdown");
{
  const t = db.addTask(USER, "stalled");
  db.addReminder(USER, t.id, "2020-01-01 09:00");

  // grammY's default is a 500s timeout; the send has to carry its own signal.
  // Asserted by inspecting what the transport was actually handed, so removing
  // the argument (or gutting the helper) fails here.
  lastSignal = new Map();
  await deliverDueReminders();
  const signal = lastSignal.get("sendMessage");
  assert.ok(signal, "the send was given no AbortSignal at all");
  assert.equal(typeof signal.aborted, "boolean", `not a signal: ${signal}`);
  assert.equal(signal.aborted, false, "the signal was already aborted");
  assert.equal(typeof signal.addEventListener, "function");
  pass("each reminder send carries a live abort signal");

  // An aborted send is transient: the reminder must survive for the next pass.
  const t2 = db.addTask(USER, "aborted");
  db.addReminder(USER, t2.id, "2020-01-01 09:00");
  failWith = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  const n = await deliverDueReminders();
  failWith = null;
  assert.equal(n, 0);
  assert.equal(db.taskReminders(USER, t2.id).length, 1, "a timeout must not drop it");
  pass("a timed-out send is retried, not discarded");
  db.removeTask(USER, t.id);
  db.removeTask(USER, t2.id);
}

// This one goes last: it flips the module's shutdown flag, after which delivery
// deliberately stops early.
console.log("\n[fix2] shutdown never closes the database under a live send");
{
  const { drainAndClose } = await import("../src/bot.ts");
  const t = db.addTask(USER, "mid-flight");
  db.addReminder(USER, t.id, "2020-01-01 09:00");

  // A send that has reached Telegram but won't come back for 300ms. A real
  // timer, not a bare promise: the grace timer is unref'd (in production an
  // in-flight send holds a live socket), so nothing else would keep the loop up.
  sendGate = new Promise((r) => setTimeout(r, 300));
  const pass1 = deliverDueReminders();
  await new Promise((r) => setImmediate(r));

  // Shutdown gives up waiting while that send is still outstanding.
  const closed = await drainAndClose(50);
  assert.equal(closed, false, "the database was closed under an in-flight send");

  // The send then completes. Before the fix this threw "statement has been
  // finalized" and left sent_at NULL — so the user got the message and then got
  // it a second time on the next start.
  const delivered = await pass1;
  sendGate = null;

  assert.equal(delivered, 1, "the in-flight send was lost");
  assert.equal(
    db.taskReminders(USER, t.id).length,
    0,
    "a delivered reminder was left pending — it would fire again on restart",
  );
  pass("the pass finishes and marks its reminder sent");

  // And when nothing is in flight, it does close, exactly as before.
  assert.equal(await drainAndClose(50), true, "an idle shutdown should close the db");
  pass("an idle shutdown still closes cleanly");
}

// drainAndClose already closed it above.
rmSync(workdir, { recursive: true, force: true });
console.log("\n✅ ALL FLOWS PASSED\n");

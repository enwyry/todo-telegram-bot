import { DatabaseSync } from "node:sqlite";

export type Task = {
  id: number;
  text: string;
  created_at: string;
  /** "YYYY-MM-DD" for an all-day task, "YYYY-MM-DD HH:MM" when a time was picked, or null. */
  deadline: string | null;
};

const db = new DatabaseSync(process.env.DB_PATH ?? "./tasks.db");

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    deadline   TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks (user_id, id);

  CREATE TABLE IF NOT EXISTS reminders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL,
    remind_at TEXT    NOT NULL,
    sent_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (sent_at, remind_at);
`);

// Databases created before deadlines existed need the column added.
const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as unknown as {
  name: string;
}[];
if (!columns.some((c) => c.name === "deadline")) {
  db.exec(`ALTER TABLE tasks ADD COLUMN deadline TEXT`);
}

// Reminders added automatically from a deadline are marked, so that re-picking
// that deadline can replace them without disturbing any the user set by hand.
const reminderColumns = db.prepare(`PRAGMA table_info(reminders)`).all() as unknown as {
  name: string;
}[];
if (!reminderColumns.some((c) => c.name === "auto")) {
  db.exec(`ALTER TABLE reminders ADD COLUMN auto INTEGER NOT NULL DEFAULT 0`);
}

// Two reminders on the same task at the same minute can only ever produce two
// identical messages, so they're collapsed to one. Older databases may already
// hold such pairs, and the unique index below cannot be created until they're
// gone — so the cleanup runs first. Sent reminders are left alone: they're
// history, and constraining them would reject a legitimate repeat next year.
db.exec(`
  DELETE FROM reminders WHERE sent_at IS NULL AND id NOT IN (
    SELECT MIN(id) FROM reminders WHERE sent_at IS NULL
    GROUP BY task_id, remind_at
  );
  CREATE UNIQUE INDEX IF NOT EXISTS reminders_unique_pending
    ON reminders (task_id, remind_at) WHERE sent_at IS NULL;
`);

const FIELDS = `id, text, created_at, deadline`;

const insertTask = db.prepare(
  `INSERT INTO tasks (user_id, text) VALUES (?, ?) RETURNING ${FIELDS}`,
);
// Dated tasks first (soonest first), undated ones at the bottom.
const selectTasks = db.prepare(
  `SELECT ${FIELDS} FROM tasks WHERE user_id = ?
   ORDER BY deadline IS NULL, deadline, id`,
);
// Every statement is scoped by user_id, so one user can never touch another's
// task by guessing an id — including via a forged callback button.
const deleteTask = db.prepare(
  `DELETE FROM tasks WHERE user_id = ? AND id = ? RETURNING ${FIELDS}`,
);
const updateDeadline = db.prepare(
  `UPDATE tasks SET deadline = ? WHERE user_id = ? AND id = ? RETURNING ${FIELDS}`,
);
const selectTask = db.prepare(
  `SELECT ${FIELDS} FROM tasks WHERE user_id = ? AND id = ?`,
);

export function addTask(userId: number, text: string): Task {
  return insertTask.get(userId, text) as Task;
}

export function listTasks(userId: number): Task[] {
  return selectTasks.all(userId) as unknown as Task[];
}

export function getTask(userId: number, id: number): Task | null {
  return (selectTask.get(userId, id) as Task | undefined) ?? null;
}

/** Returns the deleted task, or null if it did not exist / belongs to someone else. */
export function removeTask(userId: number, id: number): Task | null {
  return (deleteTask.get(userId, id) as Task | undefined) ?? null;
}

/** Pass null to clear the deadline. Returns null if the task isn't the user's. */
export function setDeadline(
  userId: number,
  id: number,
  deadline: string | null,
): Task | null {
  return (updateDeadline.get(deadline, userId, id) as Task | undefined) ?? null;
}

// ── Reminders ──────────────────────────────────────────────────────────────

export type Reminder = {
  id: number;
  task_id: number;
  remind_at: string;
  sent_at: string | null;
  /** 1 when it was derived from the task's deadline rather than chosen by hand. */
  auto: number;
  /** Text of the task this reminder belongs to, for labelling buttons. */
  text: string;
};

/** A due reminder joined with the task it belongs to, ready to send. */
export type DueReminder = Reminder & { user_id: number; text: string };

const insertReminder = db.prepare(
  `INSERT INTO reminders (task_id, user_id, remind_at, auto)
   SELECT ?, user_id, ?, ? FROM tasks WHERE id = ? AND user_id = ?
   RETURNING id, task_id, remind_at, sent_at, auto, '' AS text`,
);
const deleteAutoReminders = db.prepare(
  `DELETE FROM reminders
   WHERE user_id = ? AND task_id = ? AND auto = 1 AND sent_at IS NULL`,
);
const selectReminders = db.prepare(
  `SELECT r.id, r.task_id, r.remind_at, r.sent_at, r.auto, t.text
   FROM reminders r JOIN tasks t ON t.id = r.task_id
   WHERE r.user_id = ? AND r.sent_at IS NULL ORDER BY r.remind_at`,
);
const selectTaskReminders = db.prepare(
  `SELECT r.id, r.task_id, r.remind_at, r.sent_at, r.auto, t.text
   FROM reminders r JOIN tasks t ON t.id = r.task_id
   WHERE r.user_id = ? AND r.task_id = ? AND r.sent_at IS NULL
   ORDER BY r.remind_at`,
);
const deleteReminder = db.prepare(
  `DELETE FROM reminders WHERE user_id = ? AND id = ?
   RETURNING id, task_id, remind_at, sent_at, auto, '' AS text`,
);
const selectDue = db.prepare(
  `SELECT r.id, r.task_id, r.remind_at, r.sent_at, r.auto, r.user_id, t.text
   FROM reminders r JOIN tasks t ON t.id = r.task_id
   WHERE r.sent_at IS NULL AND r.remind_at <= ?
   ORDER BY r.remind_at`,
);
const markReminderSent = db.prepare(
  `UPDATE reminders SET sent_at = ? WHERE id = ?`,
);
const selectPendingAt = db.prepare(
  `SELECT r.id, r.task_id, r.remind_at, r.sent_at, r.auto, t.text
   FROM reminders r JOIN tasks t ON t.id = r.task_id
   WHERE r.user_id = ? AND r.task_id = ? AND r.remind_at = ? AND r.sent_at IS NULL`,
);
const selectStillPending = db.prepare(
  `SELECT 1 AS ok FROM reminders WHERE id = ? AND sent_at IS NULL`,
);

/**
 * Returns null if the task isn't the user's — the INSERT..SELECT yields no row.
 *
 * If the unique index rejects the write, a pending reminder for that exact
 * minute already exists, which is the outcome the caller wanted anyway: it is
 * returned instead of throwing. Callers check `pendingReminderAt` first, so
 * in-process this never fires; it covers a second bot process racing this one.
 */
export function addReminder(
  userId: number,
  taskId: number,
  remindAt: string,
  auto = false,
): Reminder | null {
  try {
    return (
      (insertReminder.get(taskId, remindAt, auto ? 1 : 0, taskId, userId) as
        | Reminder
        | undefined) ?? null
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return pendingReminderAt(userId, taskId, remindAt);
  }
}

/**
 * Drops a task's automatic reminders, leaving hand-made ones alone. Used when a
 * deadline is re-picked, so the defaults follow it instead of piling up.
 */
export function clearAutoReminders(userId: number, taskId: number): void {
  deleteAutoReminders.run(userId, taskId);
}

function isUniqueViolation(err: unknown): boolean {
  // SQLITE_CONSTRAINT_UNIQUE. node:sqlite exposes it as `errcode`.
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { errcode?: number }).errcode === 2067
  );
}

/** Pending (unsent) reminders for a user, soonest first. */
export function listReminders(userId: number): Reminder[] {
  return selectReminders.all(userId) as unknown as Reminder[];
}

/** Pending reminders attached to one task — used to warn before deleting it. */
export function taskReminders(userId: number, taskId: number): Reminder[] {
  return selectTaskReminders.all(userId, taskId) as unknown as Reminder[];
}

/** Returns the deleted reminder, or null if it isn't the user's. */
export function removeReminder(userId: number, id: number): Reminder | null {
  return (deleteReminder.get(userId, id) as Reminder | undefined) ?? null;
}

/** `now` is local wall time as "YYYY-MM-DD HH:MM" — the same shape we store. */
export function dueReminders(now: string): DueReminder[] {
  return selectDue.all(now) as unknown as DueReminder[];
}

/**
 * An existing pending reminder for exactly this task and minute, if any.
 *
 * Checking before inserting is race-free here rather than merely lucky:
 * `DatabaseSync` is synchronous and JavaScript is single-threaded, so no other
 * handler can interleave between the check and the insert. The unique index is
 * the backstop for the case that isn't true — a second bot process.
 */
export function pendingReminderAt(
  userId: number,
  taskId: number,
  remindAt: string,
): Reminder | null {
  return (
    (selectPendingAt.get(userId, taskId, remindAt) as Reminder | undefined) ??
    null
  );
}

/**
 * Still unsent and still there. A delivery pass selects its batch up front, and
 * the user can delete the task (cascading the reminder away) while an earlier
 * send in that same batch is still in flight.
 */
export function isStillPending(id: number): boolean {
  return selectStillPending.get(id) !== undefined;
}

export function markSent(id: number, when: string): void {
  markReminderSent.run(when, id);
}

export function closeDb(): void {
  db.close();
}

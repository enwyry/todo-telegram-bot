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
};

/** A due reminder joined with the task it belongs to, ready to send. */
export type DueReminder = Reminder & { user_id: number; text: string };

const insertReminder = db.prepare(
  `INSERT INTO reminders (task_id, user_id, remind_at)
   SELECT ?, user_id, ? FROM tasks WHERE id = ? AND user_id = ?
   RETURNING id, task_id, remind_at, sent_at`,
);
const selectReminders = db.prepare(
  `SELECT id, task_id, remind_at, sent_at FROM reminders
   WHERE user_id = ? AND sent_at IS NULL ORDER BY remind_at`,
);
const selectDue = db.prepare(
  `SELECT r.id, r.task_id, r.remind_at, r.sent_at, r.user_id, t.text
   FROM reminders r JOIN tasks t ON t.id = r.task_id
   WHERE r.sent_at IS NULL AND r.remind_at <= ?
   ORDER BY r.remind_at`,
);
const markReminderSent = db.prepare(
  `UPDATE reminders SET sent_at = ? WHERE id = ?`,
);

/** Returns null if the task isn't the user's — the INSERT..SELECT yields no row. */
export function addReminder(
  userId: number,
  taskId: number,
  remindAt: string,
): Reminder | null {
  return (
    (insertReminder.get(taskId, remindAt, taskId, userId) as
      | Reminder
      | undefined) ?? null
  );
}

/** Pending (unsent) reminders for a user. */
export function listReminders(userId: number): Reminder[] {
  return selectReminders.all(userId) as unknown as Reminder[];
}

/** `now` is local wall time as "YYYY-MM-DD HH:MM" — the same shape we store. */
export function dueReminders(now: string): DueReminder[] {
  return selectDue.all(now) as unknown as DueReminder[];
}

export function markSent(id: number, when: string): void {
  markReminderSent.run(when, id);
}

export function closeDb(): void {
  db.close();
}

import { DatabaseSync } from "node:sqlite";

export type Task = {
  id: number;
  text: string;
  created_at: string;
};

const db = new DatabaseSync(process.env.DB_PATH ?? "./tasks.db");

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks (user_id, id);
`);

const insertTask = db.prepare(
  `INSERT INTO tasks (user_id, text) VALUES (?, ?) RETURNING id, text, created_at`,
);
const selectTasks = db.prepare(
  `SELECT id, text, created_at FROM tasks WHERE user_id = ? ORDER BY id`,
);
// Scoped by user_id so one user can never delete another's task by guessing an id.
const deleteTask = db.prepare(
  `DELETE FROM tasks WHERE user_id = ? AND id = ? RETURNING id, text, created_at`,
);

export function addTask(userId: number, text: string): Task {
  return insertTask.get(userId, text) as Task;
}

export function listTasks(userId: number): Task[] {
  return selectTasks.all(userId) as unknown as Task[];
}

/** Returns the deleted task, or null if it did not exist / belongs to someone else. */
export function removeTask(userId: number, id: number): Task | null {
  return (deleteTask.get(userId, id) as Task | undefined) ?? null;
}

export function closeDb(): void {
  db.close();
}

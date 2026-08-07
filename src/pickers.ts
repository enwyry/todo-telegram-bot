import { InlineKeyboard } from "grammy";

/** Which flow the picker is driving: a task deadline, or a reminder time. */
export type Mode = "d" | "r";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");

/** Local-time "YYYY-MM-DD". Deliberately not toISOString(), which shifts to UTC. */
export function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local wall time as "YYYY-MM-DD HH:MM" — the exact shape stored in the DB, so
 *  string comparison against a stored deadline/reminder is also a time comparison. */
export function nowLocal(): string {
  const d = new Date();
  return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Calendar for one month. `cursor` is "YYYY-MM".
 * Days before today are rendered as inert buttons so a date can't land in the past.
 */
export function datePicker(
  mode: Mode,
  taskId: number,
  cursor: string,
): InlineKeyboard {
  const [yearStr, monthStr] = cursor.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1; // JS months are 0-based

  const keyboard = new InlineKeyboard();

  const prev = new Date(year, month - 1, 1);
  const next = new Date(year, month + 1, 1);
  keyboard
    .text("‹", `cal:${mode}:${taskId}:${ymd(prev).slice(0, 7)}`)
    .text(`${MONTHS[month] ?? ""} ${year}`, "noop")
    .text("›", `cal:${mode}:${taskId}:${ymd(next).slice(0, 7)}`)
    .row();

  for (const day of WEEKDAYS) keyboard.text(day, "noop");
  keyboard.row();

  // getDay() is Sunday-based; shift so the grid starts on Monday.
  const leading = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = startOfToday();

  const cells: { label: string; data: string }[] = [];
  for (let i = 0; i < leading; i++) cells.push({ label: " ", data: "noop" });

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const isPast = date < today;
    const isToday = date.getTime() === today.getTime();
    cells.push({
      label: isToday ? `·${day}·` : isPast ? "·" : String(day),
      data: isPast ? "noop" : `day:${mode}:${taskId}:${ymd(date)}`,
    });
  }
  while (cells.length % 7 !== 0) cells.push({ label: " ", data: "noop" });

  cells.forEach((cell, i) => {
    keyboard.text(cell.label, cell.data);
    if ((i + 1) % 7 === 0) keyboard.row();
  });

  const today0 = startOfToday();
  const tomorrow = new Date(today0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  keyboard
    .text("Today", `day:${mode}:${taskId}:${ymd(today0)}`)
    .text("Tomorrow", `day:${mode}:${taskId}:${ymd(tomorrow)}`)
    .row();

  // A reminder is pointless without a time, so it gets no skip/all-day escape.
  keyboard.text(
    mode === "d" ? "Skip deadline" : "Cancel",
    mode === "d" ? `skip:${taskId}` : `cancel:${taskId}`,
  );

  return keyboard;
}

/** Hours 00–23, four per row. Deadlines may also be all-day. */
export function hourPicker(
  mode: Mode,
  taskId: number,
  date: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let hour = 0; hour < 24; hour++) {
    keyboard.text(`${pad(hour)}:00`, `hr:${mode}:${taskId}:${date}:${pad(hour)}`);
    if ((hour + 1) % 4 === 0) keyboard.row();
  }
  keyboard.text("⌨️ Type a time", `type:${mode}:${taskId}:${date}`).row();
  if (mode === "d") keyboard.text("All day", `allday:${taskId}:${date}`);
  return keyboard.text("‹ Back", `cal:${mode}:${taskId}:${date.slice(0, 7)}`);
}

/** Every minute 00–59, ten per row, so any exact time is one tap away. */
export function minutePicker(
  mode: Mode,
  taskId: number,
  date: string,
  hour: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let minute = 0; minute < 60; minute++) {
    keyboard.text(
      pad(minute),
      `min:${mode}:${taskId}:${date}:${hour}:${pad(minute)}`,
    );
    if ((minute + 1) % 10 === 0) keyboard.row();
  }
  return keyboard
    .text("⌨️ Type a time", `type:${mode}:${taskId}:${date}`)
    .text("‹ Back", `day:${mode}:${taskId}:${date}`);
}

/**
 * Parses a typed time into "HH:MM". Accepts 14:37, 14.37, 1437, 9:05, 9 (→ 09:00),
 * and 2:30pm / 2pm. Returns null if it isn't a real time.
 */
export function parseTime(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, "");

  const suffix = raw.endsWith("am") ? "am" : raw.endsWith("pm") ? "pm" : null;
  const body = suffix ? raw.slice(0, -2) : raw;

  const match =
    /^(\d{1,2})[:.h]?(\d{2})$/.exec(body) ?? /^(\d{1,2})$/.exec(body);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);

  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === "pm" && hour !== 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
  }

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  return `${pad(hour)}:${pad(minute)}`;
}

/** "Fri 8 Aug, 14:30" — or "Fri 8 Aug" for an all-day task. */
export function formatDeadline(deadline: string): string {
  const [datePart, timePart] = deadline.split(" ");
  const [year, month, day] = (datePart ?? "").split("-").map(Number);
  const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);

  const label =
    `${SHORT_DAYS[date.getDay()] ?? ""} ${date.getDate()} ${SHORT_MONTHS[date.getMonth()] ?? ""}`;
  return timePart ? `${label}, ${timePart}` : label;
}

/** True once the deadline has passed. All-day tasks are late only after that day ends. */
export function isOverdue(deadline: string): boolean {
  const [datePart, timePart] = deadline.split(" ");
  const [year, month, day] = (datePart ?? "").split("-").map(Number);
  const [hour, minute] = (timePart ?? "").split(":").map(Number);

  const due = timePart
    ? new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0)
    : new Date(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1); // end of that day

  return due.getTime() < Date.now();
}

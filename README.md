# todo-telegram-bot

A Telegram bot that keeps a personal todo list with deadlines and reminders.
Every user gets their own private list.

| Command     | What it does                                                            |
| ----------- | ----------------------------------------------------------------------- |
| `/start`    | Quick intro                                                             |
| `/add`      | Add a task — `/add buy milk`, or send `/add` and reply with the text     |
| `/list`     | All tasks, soonest first, with their date, time and pending reminders   |
| `/reminder` | Pick a task, pick a date and time — the bot messages you when it's due  |
| `/remove`   | Delete a task, or just one of its reminders                             |

Give a task a **time** and it gets two reminders automatically — **1 hour** and
**30 minutes** beforehand. They behave like any other reminder: they show in
`/list`, and `/remove` can drop either one on its own.

Every task carries an **importance**: 🔵 low, 🟡 medium, 🔴 high. New tasks start
🟡, and the three buttons sit on the confirmation so it's one tap to change —
or nothing to do at all if medium is right.

```
✅ Added 🟡 dinner with mum — Tomorrow, 19:00
🔔 18:00, 18:30
Importance: 🟡 Medium

[ 🔵 Low ]  [ 🟡 Medium ✓ ]  [ 🔴 High ]
```

Pick dates and times **from buttons** — a month calendar, then an hour, then any
of the 60 minutes. Or tap **⌨️ Type a time** and write `14:37` / `2:30pm` if
that's quicker.

```
/add buy milk
   ↓
‹  August 2026  ›        ← tap a day (past days are inert)
Mo Tu We Th Fr Sa Su
                1  2
 3  4  5  6  7 ·8· 9
...
[Today] [Tomorrow]
[Skip deadline]
   ↓  tap 8
00:00 01:00 02:00 03:00  ← tap an hour, or "All day"
...
[⌨️ Type a time]
   ↓  tap 14:00
00 01 02 03 04 05 06 07 08 09   ← any minute, one tap
10 11 12 13 14 15 16 17 18 19
...                     37 ...
   ↓
✅ Added buy milk — Sat 8 Aug, 14:37
```

## Setup

Requires **Node 24+** — it uses the built-in `node:sqlite` and runs TypeScript
natively, so there is no build step and one runtime dependency.

```bash
npm install
```

Create a `.env` next to `package.json` (copy `.env.example`) and paste the token
[@BotFather](https://t.me/BotFather) gives you for `/newbot`:

```
BOT_TOKEN=123456:your-token-here
```

Then:

```bash
npm start      # run the bot
npm run dev    # run it with auto-restart on file changes
npm test       # end-to-end flow tests
npm run typecheck
```

## How it works

| File                                 | Role                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| [`src/bot.ts`](src/bot.ts)           | Commands, callback routes, reminder delivery loop          |
| [`src/pickers.ts`](src/pickers.ts)   | Calendar / hour / minute keyboards and date formatting     |
| [`src/db.ts`](src/db.ts)             | SQLite schema and queries                                  |
| [`test/flows.mjs`](test/flows.mjs)   | Drives real `Update` objects through the bot               |

**The picker is stateless.** `/add` saves the task immediately with no deadline,
and every button carries that task's id in its callback data. So a bot restart
mid-pick doesn't lose anything, and abandoning a picker just leaves the task
undated instead of leaking memory.

**Every query is scoped by `user_id`**, including updates and deletes. A forged
callback button naming someone else's task id silently affects nothing.

**Reminders** are rows with a `remind_at` and a null `sent_at`. A loop polls every
30 seconds and sends whatever is due.

**A reminder can only land between now and its task's deadline.** The calendar
greys out days past the deadline and the hour/minute grids simply omit times
that are out of range, so the choice is only ever between valid options. The
rule is re-checked in `commitWhen()` before writing, because a typed time or a
forged callback never touches the keyboard.

The exception is an **overdue** task: capping at a deadline that has already
passed would leave no slot at all, so the cap is dropped and you can still be
reminded about something late.

**Today is bracketed** (`[7]`) in every calendar, and `formatDeadline` says
"Today" / "Tomorrow" instead of a date, so the current day is obvious in lists
and buttons too.

**Deleting a task cascades to its reminders**, so `/remove` names them and asks
before going ahead. Dropping a reminder on its own leaves the task alone.

**Private chats only.** Lists are per-user, but half-finished commands are
tracked per-chat and reminders are always delivered to a user's private chat. In
a group those disagree — one member's message could land in another's pending
prompt. The bot declines group chats rather than half-supporting them.

**Long lists are split across messages.** Telegram's hard limit is 4096
characters (verified: 4096 accepted, 4097 rejected), and escaping can quintuple
a task's length (`&` becomes `&amp;`), so `/list` chunks rather than failing.
Past a dozen chunks it stops and says how much is left, rather than firing off
enough messages to trip a flood limit. Button lists are bounded the same way, by
serialised size: an over-large keyboard is rejected outright, and a rejected
keyboard means no reply at all. Both are ordered soonest-first, so what drops off
is the least urgent — and neither bound is anywhere near an ordinary list.

**Reminder passes never overlap.** A reminder is retired only after its send
resolves, so a second pass starting mid-flight would re-send it. Passes are
serialised, capped at 25 per tick, and stop early on a flood limit. Each send
carries its own 20-second timeout — grammY's default is 500 — so a stalled
connection can't wedge every later pass behind it. The batch is chosen up front
but re-checked before each send, so a reminder you cancel while an earlier one
is still sending doesn't go out anyway.

**Shutdown never closes the database under a live send.** It waits for the pass
in flight, but only for a few seconds, because a supervisor sends SIGKILL not
long after SIGTERM. If the grace runs out the handle is simply left open: every
write is already committed and WAL recovers on the next start, whereas closing
early would finalize the statements mid-send and leave a reminder Telegram had
already delivered marked unsent — so it would arrive twice.

**Importance is stored as 1/2/3, not as a colour.** The numbers are ordered, so
ranking is a plain comparison and a different palette is a display change rather
than a migration. It deliberately does **not** reorder `/list` — deadlines drive
the list, and a colour that pushed next week above this afternoon would hide the
thing that's actually due. The dot appears on every list line and task button
instead. Re-picking a deadline leaves it alone, and an older database gets 🟡.

**The default reminders follow the deadline.** They're marked in the database as
automatic, so re-picking a deadline moves them instead of leaving the old pair
behind — while any reminder you set by hand is left exactly where you put it,
including one that happens to fall on the same minute as a default. Offsets that
would land in the past are skipped, so a task due in ten minutes gets neither
rather than a reminder that fires the instant it's saved. An all-day task has no
time to count back from, so it gets none.

**The same reminder can't be set twice.** Several reminders on one task are the
point, but two at the same minute could only ever produce two identical
messages, so an exact repeat folds into the existing one and says so. A unique
index enforces it, and an older database has its duplicates collapsed on start.

**A cosmetic API failure never aborts a handler.** Answering a callback query
only dismisses the client's spinner, but it happens *before* the message the
handler is confirming. Letting it throw would abandon the handler after its
write had landed — the reminder saved, no confirmation shown, the keyboard still
live and inviting a duplicate tap. It's logged and stepped over instead.

The bot uses long polling, so it runs anywhere with outbound HTTPS — no public
URL or webhook needed. Only one instance may run at a time; a second one will
fail with a `409 Conflict` from Telegram.

## Known limits

- **Times are the server's local time**, not each user's. Telegram doesn't tell
  the bot a user's timezone, so a deadline of `14:30` means 14:30 wherever the
  bot is running. Fine for a single user on one machine; needs a per-user
  timezone setting before sharing it more widely.
- **Reminders missed while the bot is down are sent late, not skipped** — they
  stay due until delivered. Restarting after a long outage sends a burst.
- Reminder polling is 30s, so delivery can land up to 30 seconds after the
  chosen minute.
- **Deleting a task deletes its reminders.** `/remove` names them and asks first,
  but confirming does cancel them.
- **Works in private chat only** — see above. To stop it being added to groups
  at all, turn off "Groups" for the bot in @BotFather.
- A reminder that is permanently undeliverable (you blocked the bot, chat gone)
  is dropped rather than retried forever — with a log line, not silently.

## Data

Tasks live in `tasks.db` (SQLite, gitignored). Set `DB_PATH` to move it. The
schema self-migrates on start, so an older database picks up new columns without
losing rows.

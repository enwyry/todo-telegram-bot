# todo-telegram-bot

A Telegram bot that keeps a personal todo list with deadlines and reminders.
Every user gets their own private list.

| Command     | What it does                                                            |
| ----------- | ----------------------------------------------------------------------- |
| `/start`    | Quick intro                                                             |
| `/add`      | Add a task — `/add buy milk`, or send `/add` and reply with the text     |
| `/list`     | All tasks, soonest first, with their date, time and pending reminders   |
| `/reminder` | Pick a task, pick a date and time — the bot messages you when it's due  |
| `/remove`   | Pick a task from a button list to delete it                             |

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
30 seconds and sends whatever is due. Deleting a task cascades to its reminders.

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
- **Deleting a task deletes its reminders.** That's the intended cascade, but it
  means a `/remove` silently cancels anything pending for that task.

## Data

Tasks live in `tasks.db` (SQLite, gitignored). Set `DB_PATH` to move it. The
schema self-migrates on start, so an older database picks up new columns without
losing rows.

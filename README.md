# todo-telegram-bot

A small Telegram bot that keeps a personal todo list. Each user gets their own list.

| Command   | What it does                                                    |
| --------- | --------------------------------------------------------------- |
| `/start`  | Quick intro to the bot                                            |
| `/add`    | Add a task — `/add buy milk`, or send `/add` and reply with the text |
| `/remove` | Lists your tasks as buttons; tap one to remove it                 |

## Setup

Requires **Node 24+** (uses the built-in `node:sqlite` and native TypeScript support — no build step).

```bash
npm install
cp .env.example .env   # then paste your token
npm start
```

Get a token by messaging [@BotFather](https://t.me/BotFather) on Telegram and sending `/newbot`.

## How it works

- [`src/bot.ts`](src/bot.ts) — command handlers and the inline-keyboard remove flow
- [`src/db.ts`](src/db.ts) — SQLite schema and queries, all scoped by `user_id`

Tasks live in `tasks.db` (gitignored). Set `DB_PATH` to move it.

The bot uses long polling, so it runs anywhere with outbound HTTPS — no public URL or webhook needed.

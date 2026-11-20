# Ordo

Ordo runs a long piece of work as a queue of short model sessions. The memory of the work lives in YAML files, the _order_, not in a conversation. Each session starts with a clean context, gets one task and the current state from the file, hands in a short report in a fixed schema, and ends. The dispatcher spends no model tokens itself: it starts sessions, keeps time, writes down what they hand in, and calls a planner session when the plan needs to change.

It is not tied to code or git: reading scanned documents, translating a book, sorting a folder of notes or migrating a codebase are all orders.

## How it works

- **Order**: the context of the work, the models, the settings, the state, the tasks, and the owner's open questions. The owner writes it as one YAML file; on the first start the dispatcher splits it into the order file (title, context, models, settings: the owner may edit it while the dispatcher runs), the live file (state, backlog, questions: only the dispatcher writes it) and an archive with one file per task that ran.
- **Dispatcher**: one background process per order (`ordo start`). It runs up to _pool_ tasks at a time, in file order, respecting `after` dependencies.
- **Worker**: a session that does one task. Its prompt holds the context, the state, its task, and the rest of the backlog by id and title only. It reports `outcome` (`done`, `failed` or `blocked`), a `summary`, a `proposal` for what to add, drop or split in the backlog, a `note` when the backlog stays as it is, `questions` for the owner when blocked, and a `statePatch`. A note does not call the planner.
- **Replan**: when a worker proposes a change, fails, or the owner answers its questions, a _planner_ session patches the backlog (the tasks not started yet). It sees the tasks named in the reason in full, and the other tasks that ran as one line each, with the archive path where it may read them. It returns only the change: pending tasks to drop, add or replace, and the pending order when tasks are added or removed. It does not send the state or the tasks that stay. Tasks that ran are never changed. A plain success with no proposal goes straight to the next task. A patch that leaves a pending task waiting on a failed, blocked or interrupted task is rejected and the planner is asked again. If the file is already in that state, the dispatcher calls the planner before it stops.
- **Time**: the dispatcher owns the clock. It tells the live session the minute every 10 minutes, writes reminders at minutes 30, 45 and 50, and closes it at 55. The planner gets 10 minutes. All of this is configurable. Orders should not set time limits of their own; `ordo check` warns when they do.
- **Continuation**: a task cut off without a report (by the usage limit, the owner's stop, a dead dispatcher, or its time) did not fail. It goes on as a new task with the same prompt and model and a note that a previous session did part of it, without a replan. Only a continuation that runs out of time again goes to the planner.
- **Usage limit**: the dispatcher waits until the limit resets, then continues the interrupted task. When only the planner's plugin is limited, with no reset in sight, a Claude fallback plans meanwhile (`plannerFallback`).
- **Questions**: a blocked task waits for the owner; tasks that do not depend on it go on. The owner gets a notification and answers with `ordo answer`. An optional _decider_ model may answer first.
- **Disk space**: before each session the dispatcher checks the free space where transcripts are written. Below `settings.minFreeMB` (1 GB) it starts nothing, notifies the owner, and goes on by itself once there is room.
- **Restart**: everything the dispatcher knows is in the files. Started again, it continues where it stopped; tasks a dead process left running are marked interrupted and continued.

## Install

Node.js 24 or later is required. The `claude-code` plugin needs a Claude Code login on the machine (`claude` signed in). The `openai` plugin needs `OPENAI_API_KEY`.

```bash
git clone https://github.com/solvek/ordo.git
cd ordo
pnpm install
pnpm link --global   # puts `ordo` on PATH
```

## Quick start

Write an order (see [docs/order-file.md](docs/order-file.md) and [examples/](examples/)), then from the directory where the work happens:

```bash
ordo check work.yaml       # validate
ordo start work.yaml       # run in the background
ordo status work.yaml      # mode, counts, running tasks, open questions
ordo logs work.yaml -f     # follow the dispatcher log
```

Sessions run in the directory where `ordo start` was called. A `.env` file there is read first.

A good first task is a planning task: it looks at the material and, in its `proposal`, describes the tasks to add. The planner turns that into the backlog.

## Commands

| Command                                            | What it does                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ordo start <order> [--pool N] [--use-api-key]`    | Run the order in a detached process.                                                                                                                 |
| `ordo run <order> [--pool N] [--use-api-key] [-v]` | Run in the foreground (for systemd, tmux, debugging). Ctrl-C pauses, a second Ctrl-C stops.                                                          |
| `ordo status [<order>] [--json]`                   | Status of one order, or of every running dispatcher. Works from the file when nothing runs.                                                          |
| `ordo list`                                        | Running dispatchers.                                                                                                                                 |
| `ordo pause [<order>] [--drain]`                   | Start nothing new. Workers are asked to hand in now (with `--drain`, they finish their tasks). A running or owed replan finishes. The process waits. |
| `ordo resume [<order>]`                            | Go on after a pause.                                                                                                                                 |
| `ordo stop [<order>]`                              | Close every session now and exit. Running tasks become interrupted and continue on the next start.                                                   |
| `ordo answer [<order>] <id> <text>`                | Answer an open question. Through the dispatcher when it runs, in the file when it does not.                                                          |
| `ordo check [<order>]`                             | Validate the order, the model plugins and the notifiers; warn about time limits in the order and a large state. Reads an order in one file or split. |
| `ordo split <order>`                               | Split an order in one file into the order file, the live file and the archive without starting it. `ordo start` does this by itself.                 |
| `ordo logs [<order>] [-n N] [-f]`                  | The dispatcher log.                                                                                                                                  |
| `ordo notify-test [<order>]`                       | Send a test notification; for Telegram without a chat id, list the chats that wrote to the bot.                                                      |

`pause`, `resume`, `stop`, `answer`, `check`, `logs` and `notify-test` can leave the order out when exactly one dispatcher is running: the command uses that order. With none or several running, name the file. `start` and `run` always take it.

Exit code of `run`: 0 when the order is done or was stopped, 1 otherwise.

## Notifications

Notifiers are listed in the order under `settings.notify`. Built in:

- `telegram`: needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment. Create a bot with @BotFather, send it a message, run `ordo notify-test <order>` to see your chat id.
- `command`: runs a shell command with the text on stdin and `ORDO_NOTICE_KIND`, `ORDO_ORDER` in the environment.

The owner is notified about questions, a finished order, a dispatcher that stopped on an error, a usage-limit wait longer than an hour, a weekly usage window above 90 %, too little free disk space (and when it is back), and a changed order file that is not valid.

## Files

Next to `work.yaml` the dispatcher keeps the live part of the order (see [docs/order-file.md](docs/order-file.md#three-places)):

- `work.live.yaml`: state, backlog, questions, owed replans.
- `work.archive/<task id>.yaml`: each task that ran, with its full report.

and its runtime files in `work.ordo/`:

- `lock`: the process id; a second dispatcher for the same order refuses to start.
- `ordo.log`: the dispatcher log, JSON lines (pino). `ordo logs` prints it for people.
- `sessions/NNNN-<role>-<task>.log`: one transcript per session: prompt, text, thinking, tool calls and results, usage. Key-shaped secrets are cut.
- `stderr.log`: console output of a detached dispatcher.

The control socket lives in `$XDG_RUNTIME_DIR/ordo/` (or the temp directory).

Console output shows warnings and errors only; `-v` or `ORDO_LOG_LEVEL=info` shows more. `ORDO_FILE_LOG_LEVEL` sets the file log (default `info`).

## Be aware

- **Permissions.** Sessions run without permission prompts, with the same access to files and commands as the user who started the dispatcher. Run Ordo only where that is acceptable. Tools that make no sense unattended (questions to the user, scheduling, background monitors) are disabled by default; see `settings.disallowedTools`.
- **Billing.** By default `claude-code` sessions use the Claude Code login of the machine, and `ANTHROPIC_API_KEY` is not passed into them, so a key in the environment does not switch them to API billing. `--use-api-key` passes it. Check Anthropic's current terms for how unattended use counts against your plan.
- **OpenAI.** The `openai` plugin calls the Responses API with `OPENAI_API_KEY` (`OPENAI_BASE_URL` overrides the host). A session has no tools: it only sees the messages and returns the schema, and the API is asked not to store the call. A short rate limit is retried; a quota, or a reset of a minute or more, is the usage limit. The API does not report a dollar cost, so those sessions leave `costUsd` empty. `effort` is sent as `reasoning.effort`.
- **Memory.** On Linux a Claude Code session is a likelier target for the out-of-memory killer than the dispatcher. Several workers at once multiply the load; keep `pool` at 1 when tasks are heavy.
- **Model plugins.** `claude-code` and `openai`. The `SessionHost` interface is the place for others.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm ordo check examples/translate-book.yaml   # run the CLI from source
```

Code layout: `src/order.ts` (file format and pure changes), `src/dispatcher.ts` (the loop), `src/prompts.ts` (texts sent to sessions), `src/claude.ts` (the Claude Code plugin), `src/openai.ts` (the OpenAI plugin), `src/notify.ts`, `src/control.ts` (socket), `src/cli.ts`. Tests use a scripted session host and a manual clock; they never call a model. Rules for contributors and coding agents: [AGENTS.md](AGENTS.md).

## License

MIT

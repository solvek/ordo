# The order file

YAML. Unknown keys are errors. `ordo check` reports every problem with the file and the path to the field.

## Three places

The owner writes a new order as one file, `work.yaml`, as below. The first `ordo start` (or `ordo split`) splits it, so that each session reads only what it needs and the owner can edit the order while it runs:

| File                     | Holds                                                                   | Who writes it                                                                                  |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `work.yaml`              | `title`, `context`, `planner`, `plannerFallback`, `decider`, `settings` | The owner, at any time. The dispatcher reads it again before it starts a session.              |
| `work.live.yaml`         | `state`, `replan`, `questions`, and the tasks `pending` or `running`    | The dispatcher only. Edit it only after `ordo stop`.                                           |
| `work.archive/<id>.yaml` | One task that ran (any other status), with its report and `seq`         | The dispatcher, once, when the task finishes. `seq` numbers the tasks in the order they ended. |

The split keeps the owner's comments in `work.yaml`. An order in one file is still read by `ordo check`, `ordo status` and `ordo answer`; it is split only by `ordo start`, `ordo run` and `ordo split`. An order file that holds `state` or `tasks` while `work.live.yaml` exists is refused: the live part must be in one place.

A change to `work.yaml` while the dispatcher runs applies to the sessions that start after it; running sessions keep what they were started with. A change that is not valid (a bad key, a model plugin the dispatcher does not have, `state` or `tasks` put back) is refused: the dispatcher logs it, notifies the owner once and goes on with the version it has.

```yaml
title: Translate "The Lighthouse Keeper" # required
context: | # what every session reads first
  Where the material is, where results go, rules, conventions.
planner: { plugin: claude-code, name: claude-opus-5-5, effort: medium } # required
plannerFallback: { plugin: claude-code, name: claude-sonnet-5-5, effort: high } # optional
decider: { plugin: claude-code, name: claude-opus-5-5, effort: low } # optional
settings: # optional, every key optional
  pool: 1
  minutes: { tick: 10, remind: 30, wrap: 45, finish: 50, stop: 55, replan: 10, limitRetry: 30 }
  notify:
    - plugin: telegram
  disallowedTools: [AskUserQuestion, CronCreate]
state: {} # free mapping; `{}` when empty
tasks:
  - id: plan
    title: Plan the translation
    model: { plugin: claude-code, name: claude-sonnet-5-5, effort: high }
    after: [] # optional: ids that must be done first
    prompt: |
      What to do and what to hand in.
```

## What each session reads

| Session | Its prompt holds                                                                                                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker  | The context, the state, its own task, and the backlog as one line per task (id, title, `after`). It is told where the live file and the archive are, and may open them.                                                                                                |
| Planner | Why it is called, with the tasks named in the reasons in full (prompt and report); the context and the state; the tasks that ran as one line each (id, status, title) with the archive path where it may read any of them; the tasks running now; the backlog in full. |
| Decider | The context, the state, and the questions with the summary of the worker that asked them.                                                                                                                                                                              |

The context and the state go into every prompt. Keep them short; put bulky data in files the context names.

## Models

Every task, the planner and the decider name their model as `{plugin, name, effort}`:

- `plugin`: the model plugin. `claude-code` is a Claude Code session through the Agent SDK, with its tools. `openai` is the OpenAI Responses API, with no tools: the session only sees the messages and returns the schema. It needs `OPENAI_API_KEY` in the environment (`OPENAI_BASE_URL` overrides the host).
- `name`: the model name the plugin understands, such as `claude-sonnet-5-5` or the id the OpenAI API lists.
- `effort`: optional, `low`, `medium`, `high`, `xhigh` or `max`. For `openai` this is sent as `reasoning.effort`.

When the planner's plugin hits its usage limit with no reset time, or a reset further off than `minutes.limitRetry`, the dispatcher does not wait: for `minutes.limitRetry` minutes the planner runs as `plannerFallback`, and then the planner is tried again. Without `plannerFallback` the fallback is the `claude-code` model the order's tasks use most. A fallback on the planner's own plugin would hit the same limit, so then the dispatcher waits as before.

The planner names the model of each task it adds. Its prompt lists the models the order already uses and tells it not to give tasks its own model unless asked.

## Settings

| Key                  | Default   | Meaning                                                                                 |
| -------------------- | --------- | --------------------------------------------------------------------------------------- |
| `pool`               | 1         | Tasks that run at once. `--pool` and `ORDO_POOL` override it.                           |
| `minutes.tick`       | 10        | The worker is told "minute N of `stop`, keep working" this often, until `wrap`.         |
| `minutes.remind`     | 30        | First reminder: estimate what is left. Does not interrupt the current tool call.        |
| `minutes.wrap`       | 45        | Finish the current unit of work and hand in.                                            |
| `minutes.finish`     | 50        | Hand in at once.                                                                        |
| `minutes.stop`       | 55        | The session is closed; the task becomes `interrupted` (see Continuations).              |
| `minutes.replan`     | 10        | Time of a planner or decider session.                                                   |
| `minutes.limitRetry` | 30        | Wait after a usage limit with no known reset time; how long the planner fallback plans. |
| `notify`             | none      | Notifiers; see the README. Secrets come from the environment.                           |
| `disallowedTools`    | see below | Tools sessions may not use. Replaces the default list.                                  |

`remind < wrap < finish < stop` is required. The dispatcher owns time: the worker is told not to read the clock or judge time by its number of turns, and it stops for time only when one of these reminders arrives. So do not set time limits in the context or in a task ("no more than 45 minutes", "after minute 40 start nothing new"): a worker told so guesses the time and hands in early. Say what to finish when a reminder arrives instead. `ordo check` warns about a number with a unit of time (English or Ukrainian) in the context or an open task, and about a state larger than 10 KB. The default `disallowedTools` are `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`, `PushNotification`, `Monitor`, `EnterWorktree`, `ExitWorktree`.

## Tasks

| Field    | Meaning                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | Unique; letters, digits, `.`, `_` and `-`, starting with a letter or digit (it names the archive file). A replanned task gets a new id; ids of tasks that ran are never reused.                                                                                             |
| `title`  | One line.                                                                                                                                                                                                                                                                   |
| `model`  | See Models.                                                                                                                                                                                                                                                                 |
| `after`  | Ids that must be `done` before this task starts. Without it a task may start as soon as a worker is free. Tasks start in file order. A pending task may name only tasks that are `done`, `pending` or `running`. `failed`, `blocked` and `interrupted` never become `done`. |
| `prompt` | The task. Say where results go and what the report should contain.                                                                                                                                                                                                          |
| `status` | Written by the dispatcher; `pending` when missing.                                                                                                                                                                                                                          |
| `report` | Written by the dispatcher.                                                                                                                                                                                                                                                  |

Statuses:

| Status        | Meaning                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`     | Not started: the backlog.                                                                                                                                                                                             |
| `running`     | A worker has it.                                                                                                                                                                                                      |
| `done`        | The worker reported `done`.                                                                                                                                                                                           |
| `failed`      | The worker reported `failed`, crashed, or its reply was not readable. A replan follows.                                                                                                                               |
| `blocked`     | The worker asked the owner questions. Once they are all answered, a replan follows.                                                                                                                                   |
| `interrupted` | Closed at `minutes.stop`, stopped by the owner, cut by the usage limit, or left running by a dead dispatcher. `report.reason` says which (`time`, `stop`, `limit`, `crash`). It goes on as a continuation; see below. |

### Continuations

A task cut off before its worker handed in a report did not fail: its session ended for a reason outside the task. It goes on as a new pending task right after it, without the planner: the id gets `-cont` (then `-cont-2`, …), the title, model and `after` stay, and the prompt is the original one plus a paragraph: a previous session (task `<id>`) did part of this and was cut off, see what it left and go on from there. Pending tasks that waited on the cut task wait on the continuation.

This holds for the usage limit, the owner's stop and a dead dispatcher, every time. A task closed at `minutes.stop` goes on once; if its continuation is closed at `minutes.stop` too, the task is too large and a replan (`interrupted`) follows, so the planner can split it. The planner is called only for a proposal, a failed task, answers to questions, a stuck backlog, and that case.

`report` holds `summary`, `proposal`, an optional `note`, and when known `reason`, `minutes`, `turns`, `costUsd` (the API-equivalent cost the session reports).

## The worker's reply

| Field        | Meaning                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`    | `done`, `failed` or `blocked`.                                                                                                            |
| `summary`    | A few sentences on what was done.                                                                                                         |
| `proposal`   | What to add, drop or split in the backlog. Empty when the backlog stays. A non-empty proposal calls the planner even after `done`.        |
| `note`       | A note for the owner or a later task when the backlog stays. Whitespace-only is the same as omitted. A note does not call the planner.    |
| `questions`  | With `blocked`: questions to the owner. They are added to the order as `q1`, `q2`, …                                                      |
| `statePatch` | A JSON Merge Patch over `state`: changed top-level keys with their full new value, `null` removes a key. Parallel workers' patches merge. |

## Fields the dispatcher keeps

- `replan`: replan reasons not yet handled (`proposal`, `failed`, `interrupted`, `answers`, `stuck`; `limit` in files from an older Ordo), each with its `task` and `text`. Written before the planner starts, removed when its patch is saved, so a dispatcher stopped in between replans first on its next start. `stuck` means pending tasks wait on tasks that will not become `done`.
- `questions`: `id`, `task`, `text`, `askedAt`, and once answered `answer`, `answeredBy` (`owner` or the decider's model), `answeredAt`.

## Rules the dispatcher keeps

- The planner returns a patch, not the whole state and not the whole backlog. `remove` drops pending ids. `upsert` replaces a pending task in place or adds a new one. `order`, when present, is exactly the pending ids after the edit and becomes their order; it is required when a task is added or removed, and omitted when tasks are only replaced in place or nothing changes. Tasks that are not pending stay, in file order, and their ids are not reused. `statePatch` is a JSON Merge Patch on the state at the moment the reply is applied, so a key a worker wrote while the planner ran stays unless the patch names that key. Omit it to leave the state alone. The replan items the planner was shown are dropped; items queued while it ran stay.
- While the planner runs, no new task starts.
- A planner that fails twice in a row (timeout, unreadable reply, invalid patch) stops the dispatcher once the running tasks are done (`replan-failed`). The owed replan stays in the file.
- A planner patch that leaves a pending task waiting on a `failed`, `blocked` or `interrupted` task is rejected, and the planner is asked again. When the file is already in that state and no replan is owed, the dispatcher calls the planner before it stops. Two failed replans in a row stop the dispatcher once the running tasks are done (`replan-failed`).
- When pending tasks still cannot start and no question is open, the dispatcher stops as `stuck`.
- If the live file changes on disk while the dispatcher runs, it does not overwrite it: it stops (`conflict`) and leaves its own version of the whole order in `<order>.ordo/order.conflict.yaml`. Change the live file only through `ordo answer`, or after `ordo stop`. The order file is the owner's: editing it is never a conflict.

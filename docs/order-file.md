# The order file

YAML. Unknown keys are errors. `ordo check` reports every problem with the path to the field.

```yaml
title: Translate "The Lighthouse Keeper" # required
context: | # what every session reads first
  Where the material is, where results go, rules, conventions.
planner: { plugin: claude-code, name: claude-opus-5-5, effort: medium } # required
decider: { plugin: claude-code, name: claude-opus-5-5, effort: low } # optional
settings: # optional, every key optional
  pool: 1
  minutes: { remind: 30, wrap: 45, finish: 50, stop: 55, replan: 10, limitRetry: 30 }
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

## Models

Every task, the planner and the decider name their model as `{plugin, name, effort}`:

- `plugin`: the model plugin. `claude-code` is a Claude Code session through the Agent SDK, with its tools. `openai` is the OpenAI Responses API, with no tools: the session only sees the messages and returns the schema. It needs `OPENAI_API_KEY` in the environment (`OPENAI_BASE_URL` overrides the host).
- `name`: the model name the plugin understands, such as `claude-sonnet-5-5` or the id the OpenAI API lists.
- `effort`: optional, `low`, `medium`, `high`, `xhigh` or `max`. For `openai` this is sent as `reasoning.effort`.

The planner names the model of each task it adds. Its prompt lists the models the order already uses and tells it not to give tasks its own model unless asked.

## Settings

| Key                  | Default   | Meaning                                                                          |
| -------------------- | --------- | -------------------------------------------------------------------------------- |
| `pool`               | 1         | Tasks that run at once. `--pool` and `ORDO_POOL` override it.                    |
| `minutes.remind`     | 30        | First reminder: estimate what is left. Does not interrupt the current tool call. |
| `minutes.wrap`       | 45        | Finish the current unit of work and hand in.                                     |
| `minutes.finish`     | 50        | Hand in at once.                                                                 |
| `minutes.stop`       | 55        | The session is closed; the task becomes `interrupted` and is replanned.          |
| `minutes.replan`     | 10        | Time of a planner or decider session.                                            |
| `minutes.limitRetry` | 30        | Wait after a usage limit with no known reset time.                               |
| `notify`             | none      | Notifiers; see the README. Secrets come from the environment.                    |
| `disallowedTools`    | see below | Tools sessions may not use. Replaces the default list.                           |

`remind < wrap < finish < stop` is required. The default `disallowedTools` are `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`, `PushNotification`, `Monitor`, `EnterWorktree`, `ExitWorktree`.

## Tasks

| Field    | Meaning                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | Unique. A replanned task gets a new id; ids of tasks that ran are never reused.                                                                                                                                                                                             |
| `title`  | One line.                                                                                                                                                                                                                                                                   |
| `model`  | See Models.                                                                                                                                                                                                                                                                 |
| `after`  | Ids that must be `done` before this task starts. Without it a task may start as soon as a worker is free. Tasks start in file order. A pending task may name only tasks that are `done`, `pending` or `running`. `failed`, `blocked` and `interrupted` never become `done`. |
| `prompt` | The task. Say where results go and what the report should contain.                                                                                                                                                                                                          |
| `status` | Written by the dispatcher; `pending` when missing.                                                                                                                                                                                                                          |
| `report` | Written by the dispatcher.                                                                                                                                                                                                                                                  |

Statuses:

| Status        | Meaning                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`     | Not started: the backlog.                                                                                                                                                                      |
| `running`     | A worker has it.                                                                                                                                                                               |
| `done`        | The worker reported `done`.                                                                                                                                                                    |
| `failed`      | The worker reported `failed`, crashed, or its reply was not readable. A replan follows.                                                                                                        |
| `blocked`     | The worker asked the owner questions. Once they are all answered, a replan follows.                                                                                                            |
| `interrupted` | Closed at `minutes.stop`, stopped by the owner, cut by the usage limit, or left running by a dead dispatcher. `report.reason` says which (`time`, `stop`, `limit`, `crash`). A replan follows. |

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

- `replan`: replan reasons not yet handled (`proposal`, `failed`, `interrupted`, `limit`, `answers`, `stuck`), each with its `task` and `text`. Written before the planner starts, removed when its patch is saved, so a dispatcher stopped in between replans first on its next start. `stuck` means pending tasks wait on tasks that will not become `done`.
- `questions`: `id`, `task`, `text`, `askedAt`, and once answered `answer`, `answeredBy` (`owner` or the decider's model), `answeredAt`.

## Rules the dispatcher keeps

- The planner returns a patch, not the whole state and not the whole backlog. `remove` drops pending ids. `upsert` replaces a pending task in place or adds a new one. `order`, when present, is exactly the pending ids after the edit and becomes their order; it is required when a task is added or removed, and omitted when tasks are only replaced in place or nothing changes. Tasks that are not pending stay, in file order, and their ids are not reused. `statePatch` is a JSON Merge Patch on the state at the moment the reply is applied, so a key a worker wrote while the planner ran stays unless the patch names that key. Omit it to leave the state alone. The replan items the planner was shown are dropped; items queued while it ran stay.
- While the planner runs, no new task starts.
- A planner that fails twice in a row (timeout, unreadable reply, invalid patch) stops the dispatcher once the running tasks are done (`replan-failed`). The owed replan stays in the file.
- A planner patch that leaves a pending task waiting on a `failed`, `blocked` or `interrupted` task is rejected, and the planner is asked again. When the file is already in that state and no replan is owed, the dispatcher calls the planner before it stops. Two failed replans in a row stop the dispatcher once the running tasks are done (`replan-failed`).
- When pending tasks still cannot start and no question is open, the dispatcher stops as `stuck`.
- If the order file changes on disk while the dispatcher runs, it does not overwrite it: it stops (`conflict`) and leaves its own version in `<order>.ordo/order.conflict.yaml`. Change an order only through `ordo answer`, or after `ordo stop`.

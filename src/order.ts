// An order: context, models of the planner and the decider, settings, state, tasks and the
// owner's questions. It is kept in three places. The order file holds what the owner writes and
// may edit at any time (title, context, models, settings). The live file holds what the
// dispatcher writes (state, backlog, questions, owed replans). Each task that ran is moved to its
// own file in the archive. An order not started yet may be one file; the dispatcher splits it.
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const Effort = z.enum(EFFORTS);
export type EffortName = z.infer<typeof Effort>;

export const STATUSES = ["pending", "running", "done", "failed", "blocked", "interrupted"] as const;
export const Status = z.enum(STATUSES);
export type TaskStatus = z.infer<typeof Status>;

/** Why a task stopped before its worker handed in a report. */
export const INTERRUPT_REASONS = ["time", "stop", "crash", "limit"] as const;
export type InterruptReason = (typeof INTERRUPT_REASONS)[number];

/** Why a replan is owed. */
export const REPLAN_REASONS = [
  "proposal",
  "failed",
  "interrupted",
  "limit",
  "answers",
  "stuck",
] as const;
export type ReplanReason = (typeof REPLAN_REASONS)[number];

/** An order the dispatcher refuses to run, or a change it refuses to apply. */
export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderError";
  }
}

/** Which model runs a session: the plugin that calls it, the model name, the effort. */
export const ModelSpec = z.strictObject({
  plugin: z.string().min(1).describe("Model plugin, such as claude-code."),
  name: z.string().min(1).describe("Model name for the plugin, such as claude-sonnet-5-5."),
  effort: Effort.optional(),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

const Minutes = z.strictObject({
  remind: z.number().positive().optional(),
  wrap: z.number().positive().optional(),
  finish: z.number().positive().optional(),
  stop: z.number().positive().optional(),
  replan: z.number().positive().optional(),
  limitRetry: z.number().positive().optional(),
});

const NotifierConfig = z.looseObject({ plugin: z.string().min(1) });
export type NotifierConfig = z.infer<typeof NotifierConfig>;

const SettingsFile = z.strictObject({
  pool: z.number().int().min(1).optional(),
  minutes: Minutes.optional(),
  notify: z.array(NotifierConfig).optional(),
  disallowedTools: z.array(z.string().min(1)).optional(),
});
export type SettingsFile = z.infer<typeof SettingsFile>;

const State = z.record(z.string(), z.unknown());
export type OrderState = z.infer<typeof State>;

const Report = z.strictObject({
  summary: z.string(),
  proposal: z.string(),
  /** A note that does not change the backlog. Empty or absent calls nothing. */
  note: z.string().optional(),
  reason: z.enum(INTERRUPT_REASONS).optional(),
  minutes: z.number().optional(),
  turns: z.number().int().optional(),
  costUsd: z.number().optional(),
});
export type TaskReport = z.infer<typeof Report>;

/** A task id names its archive file, so it is a plain word. */
const TaskId = z
  .string()
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u,
    "use letters, digits, '.', '_' and '-', starting with a letter or digit",
  );

const taskShape = {
  id: TaskId,
  title: z.string().min(1),
  model: ModelSpec,
  after: z.array(z.string().min(1)).optional(),
  prompt: z.string().min(1),
  status: Status.default("pending"),
  report: Report.optional(),
};
const TaskFile = z.strictObject(taskShape);
export type Task = z.infer<typeof TaskFile>;

/** A task that ran, in its archive file. `seq` keeps the order in which tasks were archived. */
const ArchivedFile = z.strictObject({ ...taskShape, seq: z.number().int().positive() });
export interface ArchivedTask {
  seq: number;
  task: Task;
}

const Question = z.strictObject({
  id: z.string().min(1),
  task: z.string().min(1),
  text: z.string().min(1),
  askedAt: z.string().min(1),
  answer: z.string().optional(),
  answeredBy: z.string().optional(),
  answeredAt: z.string().optional(),
});
export type Question = z.infer<typeof Question>;

const ReplanItem = z.strictObject({
  reason: z.enum(REPLAN_REASONS),
  task: z.string().min(1),
  text: z.string(),
});
export type ReplanItem = z.infer<typeof ReplanItem>;

const headShape = {
  title: z.string().min(1),
  context: z.string(),
  planner: ModelSpec,
  decider: ModelSpec.optional(),
  settings: SettingsFile.optional(),
};
const liveShape = {
  state: State,
  replan: z.array(ReplanItem).optional(),
  questions: z.array(Question).optional(),
  tasks: z.array(TaskFile),
};
/** Keys of the live part. An order file with any of them is an order in one file. */
export const LIVE_KEYS = ["state", "replan", "questions", "tasks"] as const;

const HeadFile = z.strictObject(headShape);
export type OrderHead = z.infer<typeof HeadFile>;
const LiveFile = z.strictObject(liveShape);
export type OrderLive = z.infer<typeof LiveFile>;
const OrderFile = z.strictObject({ ...headShape, ...liveShape });
export type Order = z.infer<typeof OrderFile>;

/** What a worker hands in. `statePatch` is a JSON Merge Patch over the order state. */
export const WorkerReply = z.strictObject({
  outcome: z
    .enum(["done", "failed", "blocked"])
    .describe(
      "done: the task is complete. failed: it cannot be completed as given; say why and what is left in proposal. blocked: it cannot go on without the owner's answers; ask them in questions.",
    ),
  summary: z.string().min(1).describe("A few sentences on what was done."),
  proposal: z
    .string()
    .describe(
      "What to add, drop or split in the backlog. Empty when the backlog stays. A non-empty proposal calls the planner. Notes for a later task go in note, not here.",
    ),
  note: z
    .string()
    .optional()
    .describe(
      "A note for the owner or a later task that does not change the backlog. Omit when there is nothing. A note does not call the planner.",
    ),
  questions: z
    .array(z.string().min(1))
    .optional()
    .describe("Only with outcome blocked: questions to the owner, each one self-contained."),
  statePatch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Only the top-level state keys that changed, each with its full new value; null removes a key. Omit when the state did not change.",
    ),
});
export type WorkerReply = z.infer<typeof WorkerReply>;

const TaskDraft = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  model: ModelSpec,
  after: z
    .array(z.string().min(1))
    .optional()
    .describe("Ids of tasks that must be done before this one."),
  prompt: z.string().min(1),
});
export type TaskDraft = z.infer<typeof TaskDraft>;

/**
 * What the planner returns: a patch. Tasks and state keys it does not mention stay.
 * Sending the whole backlog back would spend the reply on copying what already stands.
 */
export const PlannerReply = z.strictObject({
  statePatch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Only the top-level state keys that changed, each with its full new value; null removes a key. Omit when the state did not change.",
    ),
  remove: z
    .array(z.string().min(1))
    .optional()
    .describe("Ids of pending tasks to drop. Omit when none."),
  upsert: z
    .array(TaskDraft)
    .optional()
    .describe(
      "Tasks to add or replace. An id that is already pending is replaced; a new id is added. Omit tasks that stay as they are.",
    ),
  order: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Every pending task id after the change, in run order. Required when tasks are added, removed or reordered. Omit when tasks are only replaced in place or nothing changes.",
    ),
});
export type PlannerReply = z.infer<typeof PlannerReply>;

/** What the decider returns. An empty answer leaves the question to the owner. */
export const DeciderReply = z.strictObject({
  answers: z.array(
    z.strictObject({
      id: z.string().min(1),
      answer: z.string().describe("Empty when the owner has to decide."),
    }),
  ),
});
export type DeciderReply = z.infer<typeof DeciderReply>;

/** JSON Schema of a reply, for the structured output of a session. */
export function replySchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" });
  const { $schema: _ignored, ...rest } = json;
  return rest;
}

function issueText(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "order" : issue.path.map(String).join(".");
    return `${path}: ${issue.message}`;
  });
}

function yamlValue(text: string): unknown {
  try {
    const value: unknown = parse(text);
    return value;
  } catch (error: unknown) {
    throw new OrderError(`not YAML: ${error instanceof Error ? error.message : "parse error"}`);
  }
}

function checked<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new OrderError(issueText(parsed.error).join("\n"));
  return parsed.data;
}

/** Parse an order kept in one file. Throws {@link OrderError} naming every problem. */
export function parseOrder(text: string): Order {
  const order = checked(OrderFile, yamlValue(text));
  const problems = orderProblems(order);
  if (problems.length > 0) throw new OrderError(problems.join("\n"));
  return order;
}

/**
 * Parse the order file. `live` is set when the file still holds the live part too: an order not
 * started yet, or one written by an Ordo that kept everything in one file.
 */
export function parseOrderFile(text: string): { head: OrderHead; live: OrderLive | null } {
  const raw = yamlValue(text);
  if (isRecord(raw) && LIVE_KEYS.some((key) => key in raw)) {
    const order = checked(OrderFile, raw);
    return { head: headOf(order), live: liveOf(order, true) };
  }
  return { head: checked(HeadFile, raw), live: null };
}

export function parseLive(text: string): OrderLive {
  return checked(LiveFile, yamlValue(text));
}

export function parseArchived(text: string): ArchivedTask {
  const { seq, ...task } = checked(ArchivedFile, yamlValue(text));
  return { seq, task };
}

/**
 * The whole order from its parts: archived tasks first, in archive order, then the live tasks.
 * A live task that is archived too was archived just before a crash; the archive wins.
 */
export function joinOrder(
  head: OrderHead,
  live: OrderLive,
  archived: readonly ArchivedTask[],
): Order {
  const ran = [...archived].sort((a, b) => a.seq - b.seq).map((item) => item.task);
  const ranIds = new Set(ran.map((task) => task.id));
  const order: Order = {
    ...head,
    state: live.state,
    ...(live.replan === undefined ? {} : { replan: live.replan }),
    ...(live.questions === undefined ? {} : { questions: live.questions }),
    tasks: [...ran, ...live.tasks.filter((task) => !ranIds.has(task.id))],
  };
  const problems = orderProblems(order);
  if (problems.length > 0) throw new OrderError(problems.join("\n"));
  return order;
}

export function headOf(order: Order): OrderHead {
  const head: OrderHead = {
    title: order.title,
    context: order.context,
    planner: order.planner,
  };
  if (order.decider !== undefined) head.decider = order.decider;
  if (order.settings !== undefined) head.settings = order.settings;
  return head;
}

/** The order with a new head; the live part and the tasks stay. */
export function withHead(order: Order, head: OrderHead): Order {
  const { title: _t, context: _c, planner: _p, decider: _d, settings: _s, ...live } = order;
  return { ...head, ...live };
}

/** A task is archived once it ran: every status but pending and running. */
export function isFinished(task: Task): boolean {
  return task.status !== "pending" && task.status !== "running";
}

/** The live part. Without `all`, only the tasks that have not finished. */
export function liveOf(order: Order, all = false): OrderLive {
  const live: OrderLive = {
    state: order.state,
    tasks: all ? order.tasks : order.tasks.filter((task) => !isFinished(task)),
  };
  if (order.replan !== undefined) live.replan = order.replan;
  if (order.questions !== undefined) live.questions = order.questions;
  return live;
}

export function formatLive(order: Order): string {
  return stringify(liveOf(order), { lineWidth: 0 });
}

export function formatArchived(task: Task, seq: number): string {
  return stringify({ ...task, seq }, { lineWidth: 0 });
}

/** Problems a schema cannot see: names that point nowhere, repeated ids, cycles. */
export function orderProblems(order: Order): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const task of order.tasks) {
    if (ids.has(task.id)) problems.push(`tasks: duplicate id ${task.id}`);
    ids.add(task.id);
  }
  for (const task of order.tasks) {
    for (const dep of task.after ?? []) {
      if (dep === task.id) problems.push(`tasks.${task.id}.after: a task cannot wait for itself`);
      else if (!ids.has(dep)) problems.push(`tasks.${task.id}.after: no task ${dep}`);
    }
  }
  const cycle = findCycle(order.tasks);
  if (cycle !== null) problems.push(`tasks: after makes a cycle ${cycle.join(" -> ")}`);
  const questionIds = new Set<string>();
  for (const question of order.questions ?? []) {
    if (questionIds.has(question.id)) problems.push(`questions: duplicate id ${question.id}`);
    questionIds.add(question.id);
    if (!ids.has(question.task))
      problems.push(`questions.${question.id}.task: no task ${question.task}`);
  }
  for (const item of order.replan ?? []) {
    if (!ids.has(item.task)) problems.push(`replan: no task ${item.task}`);
  }
  const minutes = minutesOf(order.settings);
  if (!(
    minutes.remind < minutes.wrap &&
    minutes.wrap < minutes.finish &&
    minutes.finish < minutes.stop
  )) {
    problems.push("settings.minutes: need remind < wrap < finish < stop");
  }
  return problems;
}

function findCycle(tasks: readonly Task[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();
  const visit = (id: string): string[] | null => {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    onPath.add(id);
    path.push(id);
    for (const dep of byId.get(id)?.after ?? []) {
      if (!byId.has(dep)) continue;
      const found = visit(dep);
      if (found !== null) return found;
    }
    path.pop();
    onPath.delete(id);
    done.add(id);
    return null;
  };
  for (const task of tasks) {
    const found = visit(task.id);
    if (found !== null) return found;
  }
  return null;
}

export interface Minutes {
  remind: number;
  wrap: number;
  finish: number;
  stop: number;
  replan: number;
  limitRetry: number;
}

export const DEFAULT_MINUTES: Minutes = {
  remind: 30,
  wrap: 45,
  finish: 50,
  stop: 55,
  replan: 10,
  limitRetry: 30,
};

export function minutesOf(settings: SettingsFile | undefined): Minutes {
  const given = settings?.minutes ?? {};
  return {
    remind: given.remind ?? DEFAULT_MINUTES.remind,
    wrap: given.wrap ?? DEFAULT_MINUTES.wrap,
    finish: given.finish ?? DEFAULT_MINUTES.finish,
    stop: given.stop ?? DEFAULT_MINUTES.stop,
    replan: given.replan ?? DEFAULT_MINUTES.replan,
    limitRetry: given.limitRetry ?? DEFAULT_MINUTES.limitRetry,
  };
}

/** YAML text of an order, with a trailing newline. Long lines are not folded. */
export function formatOrder(order: Order): string {
  return stringify(order, { lineWidth: 0 });
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Every model plugin the order names. */
export function orderPlugins(order: Order): Set<string> {
  const plugins = new Set([order.planner.plugin, ...order.tasks.map((task) => task.model.plugin)]);
  if (order.decider !== undefined) plugins.add(order.decider.plugin);
  return plugins;
}

export function modelText(spec: ModelSpec): string {
  return `${spec.name}${spec.effort === undefined ? "" : ` (${spec.effort})`} via ${spec.plugin}`;
}

export function sameModel(a: ModelSpec, b: ModelSpec): boolean {
  return a.plugin === b.plugin && a.name === b.name;
}

export function pendingTasks(order: Order): Task[] {
  return order.tasks.filter((task) => task.status === "pending");
}

/** Statuses that already satisfy `after`, or still can. The others never become `done`. */
const OPENABLE = new Set<TaskStatus>(["done", "pending", "running"]);

/**
 * Pending tasks whose `after` names a task that will not become `done`.
 * The order may be saved in this state; a planner patch that leaves it is refused.
 */
export function backlogBlockers(order: Order): string[] {
  const status = new Map(order.tasks.map((task) => [task.id, task.status]));
  const problems: string[] = [];
  for (const task of order.tasks) {
    if (task.status !== "pending") continue;
    for (const dep of task.after ?? []) {
      const depStatus = status.get(dep);
      if (depStatus === undefined || OPENABLE.has(depStatus)) continue;
      problems.push(`tasks.${task.id}.after: ${dep} is ${depStatus} and will not be done`);
    }
  }
  return problems;
}

/** Pending tasks whose `after` tasks are all done, in file order. */
export function runnableTasks(order: Order): Task[] {
  const status = new Map(order.tasks.map((task) => [task.id, task.status]));
  return pendingTasks(order).filter((task) =>
    (task.after ?? []).every((dep) => status.get(dep) === "done"),
  );
}

export function openQuestions(order: Order): Question[] {
  return (order.questions ?? []).filter((question) => question.answer === undefined);
}

export function countByStatus(order: Order): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    interrupted: 0,
  };
  for (const task of order.tasks) counts[task.status] += 1;
  return counts;
}

export function updateTask(order: Order, id: string, change: (task: Task) => Task): Order {
  return { ...order, tasks: order.tasks.map((task) => (task.id === id ? change(task) : task)) };
}

export function withReplan(order: Order, item: ReplanItem): Order {
  return { ...order, replan: [...(order.replan ?? []), item] };
}

function taskFromDraft(draft: TaskDraft): Task {
  const task: Task = {
    id: draft.id,
    title: draft.title,
    model: draft.model,
    prompt: draft.prompt,
    status: "pending",
  };
  if (draft.after !== undefined && draft.after.length > 0) task.after = draft.after;
  return task;
}

/**
 * Apply a planner patch. Tasks that ran or are running stay, in their order, and their ids
 * cannot reappear. Pending tasks that the patch does not mention stay too. The first
 * `consumed` replan items are settled; items queued while the planner worked stay.
 */
export function applyPlan(order: Order, reply: PlannerReply, consumed: number): Order {
  const kept = order.tasks.filter((task) => task.status !== "pending");
  const keptIds = new Set(kept.map((task) => task.id));
  const remove = new Set(reply.remove ?? []);
  for (const id of remove) {
    if (
      keptIds.has(id) ||
      !order.tasks.some((task) => task.id === id && task.status === "pending")
    ) {
      throw new OrderError(`cannot remove task ${id}: it is not pending`);
    }
  }
  let pending = order.tasks.filter((task) => task.status === "pending" && !remove.has(task.id));
  const seen = new Set<string>();
  const added: Task[] = [];
  for (const draft of reply.upsert ?? []) {
    if (seen.has(draft.id)) throw new OrderError(`upsert repeats task id ${draft.id}`);
    seen.add(draft.id);
    if (keptIds.has(draft.id)) {
      throw new OrderError(`upsert task ${draft.id} repeats a task that is not pending`);
    }
    const task = taskFromDraft(draft);
    const index = pending.findIndex((item) => item.id === draft.id);
    if (index >= 0) pending[index] = task;
    else added.push(task);
  }
  if (reply.order !== undefined) {
    const want = reply.order;
    if (new Set(want).size !== want.length) throw new OrderError("order repeats an id");
    const byId = new Map([...pending, ...added].map((task) => [task.id, task]));
    if (want.length !== byId.size || want.some((id) => !byId.has(id))) {
      throw new OrderError(
        `order must list exactly the pending tasks: ${[...byId.keys()].join(", ")}`,
      );
    }
    pending = want.map((id) => {
      const task = byId.get(id);
      if (task === undefined) throw new OrderError(`order names missing task ${id}`);
      return task;
    });
  } else if (remove.size > 0 || added.length > 0) {
    throw new OrderError("order is required when tasks are added or removed");
  }
  const state =
    reply.statePatch === undefined ? order.state : patchState(order.state, reply.statePatch);
  const rest = (order.replan ?? []).slice(consumed);
  const next: Order = { ...order, state, tasks: [...kept, ...pending] };
  if (rest.length > 0) next.replan = rest;
  else delete next.replan;
  const problems = [...orderProblems(next), ...backlogBlockers(next)];
  if (problems.length > 0) throw new OrderError(problems.join("\n"));
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 7396 JSON Merge Patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch;
  const base: Record<string, unknown> = isRecord(target) ? target : {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!(key in patch)) result[key] = value;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null) result[key] = mergePatch(base[key], value);
  }
  return result;
}

export function patchState(state: OrderState, patch: Record<string, unknown>): OrderState {
  const merged = mergePatch(state, patch);
  return isRecord(merged) ? merged : {};
}

/** The top-level change from `before` to `after`, as a merge patch. */
export function stateDiff(before: OrderState, after: OrderState): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(before)) if (!(key in after)) patch[key] = null;
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) patch[key] = value;
  }
  return patch;
}

/** Add a worker's questions; ids go on from the largest `qN` in the order. */
export function addQuestions(
  order: Order,
  task: string,
  texts: readonly string[],
  now: Date,
): Order {
  const existing = order.questions ?? [];
  let last = 0;
  for (const question of existing) {
    const match = /^q(\d+)$/.exec(question.id);
    if (match?.[1] !== undefined) last = Math.max(last, Number(match[1]));
  }
  const added = texts.map((text) => {
    last += 1;
    return { id: `q${String(last)}`, task, text, askedAt: now.toISOString() };
  });
  return { ...order, questions: [...existing, ...added] };
}

/**
 * Record an answer. When every question of a blocked task is answered, a replan with the
 * answers is owed: the planner decides how the work goes on.
 */
export function answerQuestion(
  order: Order,
  id: string,
  answer: string,
  by: string,
  now: Date,
): Order {
  const questions = order.questions ?? [];
  const question = questions.find((item) => item.id === id);
  if (question === undefined) throw new OrderError(`no question ${id}`);
  if (question.answer !== undefined) throw new OrderError(`question ${id} is already answered`);
  if (answer.trim() === "") throw new OrderError("the answer is empty");
  const answered = questions.map((item) =>
    item.id === id ? { ...item, answer, answeredBy: by, answeredAt: now.toISOString() } : item,
  );
  let next: Order = { ...order, questions: answered };
  const ofTask = answered.filter((item) => item.task === question.task);
  const task = order.tasks.find((item) => item.id === question.task);
  if (task?.status === "blocked" && ofTask.every((item) => item.answer !== undefined)) {
    const text = ofTask
      .map(
        (item) =>
          `${item.id}. ${item.text}\nAnswer (${item.answeredBy ?? "owner"}): ${item.answer ?? ""}`,
      )
      .join("\n\n");
    next = withReplan(next, { reason: "answers", task: question.task, text });
  }
  return next;
}

/**
 * A dispatcher that vanished left tasks `running`. They become `interrupted` and the planner
 * decides how to go on.
 */
export function recoverOrder(order: Order): Order | null {
  const running = order.tasks.filter((task) => task.status === "running");
  if (running.length === 0) return null;
  let next: Order = order;
  for (const task of running) {
    next = updateTask(next, task.id, (item) => ({
      ...item,
      status: "interrupted",
      report: {
        summary: "The session was cut off before it handed in a report; the dispatcher stopped.",
        proposal: "",
        reason: "crash",
      },
    }));
    next = withReplan(next, { reason: "interrupted", task: task.id, text: "" });
  }
  return next;
}

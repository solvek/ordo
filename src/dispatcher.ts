// The dispatcher: one process, one order. It spends no model tokens itself. It starts worker
// sessions for runnable tasks, writes the time into them, records what they hand in, and calls
// the planner when the backlog needs a decision. The order file is its memory: a dispatcher
// started again continues from the file.
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlRequest, type ControlResponse } from "./control.ts";
import { type OrderPaths, acquireLock, orderPaths, readOrderText, writeAtomic } from "./files.ts";
import { type Log, silentLog } from "./logger.ts";
import { type Notice, type NoticeKind, type Notifier } from "./notify.ts";
import {
  DeciderReply,
  DEFAULT_MINUTES,
  type Minutes,
  type Order,
  OrderError,
  PlannerReply,
  type Task,
  type TaskReport,
  WorkerReply,
  addQuestions,
  answerQuestion,
  applyPlan,
  backlogBlockers,
  formatOrder,
  minutesOf,
  modelText,
  openQuestions,
  orderPlugins,
  parseOrder,
  patchState,
  pendingTasks,
  recoverOrder,
  replySchema,
  runnableTasks,
  textHash,
  updateTask,
  withReplan,
} from "./order.ts";
import {
  PAUSE_TEXT,
  STOP_SUMMARY,
  deciderPrompt,
  finishText,
  plannerPrompt,
  remindText,
  timeoutSummary,
  workerPrompt,
  wrapText,
} from "./prompts.ts";
import {
  type Clock,
  type RunningSession,
  type SessionAnswer,
  type SessionHost,
  SessionLimitError,
  type SessionRequest,
  type SessionRole,
  type SessionUsage,
  type Timer,
  type UsageWindow,
  systemClock,
} from "./session.ts";
import { type Mode, type StatusReport, totals } from "./status.ts";
import { redact } from "./transcript.ts";

/**
 * Tools a worker cannot use well: nobody answers a question or approves a plan, and scheduled
 * or background work outlives the session.
 */
export const DEFAULT_DISALLOWED_TOOLS: readonly string[] = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
];

/** The limit is tried again this long after the time it is said to reset. */
const LIMIT_GRACE_MS = 60_000;
/** A limit wait longer than this is worth a notification. */
const LONG_LIMIT_MS = 60 * 60_000;
/** A usage window this full is worth a notification. */
const USAGE_WARNING = 0.9;
/** A replan that fails this many times in a row stops the dispatcher. */
const REPLAN_ATTEMPTS = 2;

/**
 * `done`: no task left and no open question. `stopped`: the owner stopped it. `replan-failed`:
 * the planner failed twice in a row. `stuck`: pending tasks wait for tasks that will not be done.
 * `conflict`: someone else changed the order file. `error`: an internal error.
 */
export type StopReason = "done" | "stopped" | "replan-failed" | "stuck" | "conflict" | "error";

export interface RunResult {
  reason: StopReason;
  detail?: string;
}

export interface DispatcherOptions {
  /** The order file. */
  file: string;
  /** Working directory of the sessions. */
  cwd: string;
  /** Model plugins by name, such as `claude-code`. */
  hosts: Readonly<Record<string, SessionHost>>;
  clock?: Clock;
  log?: Log;
  /** Built from the order once it is read. */
  notifiers?: (order: Order) => Notifier[];
  /** Pool size over the order's `settings.pool`. */
  pool?: number;
  paths?: OrderPaths;
}

class ConflictError extends Error {
  constructor() {
    super("the order file was changed by someone else while the dispatcher ran");
    this.name = "ConflictError";
  }
}

interface WorkerRun {
  task: Task;
  session: RunningSession;
  startedAt: number;
  timers: Timer[];
  settled: boolean;
  pauseAsked: boolean;
}

interface MetaRun {
  kind: "planner" | "decider";
  session: RunningSession;
  startedAt: number;
  timer: Timer;
  settled: boolean;
  /** Planner: how many replan items it was shown. */
  consumed: number;
  /** Decider: the questions it was shown. */
  questionIds: string[];
}

type WorkerEnd =
  | { kind: "answer"; answer: SessionAnswer }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

type MetaEnd =
  | { kind: "answer"; answer: SessionAnswer }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

export class Dispatcher {
  readonly result: Promise<RunResult>;
  private resolveResult: (result: RunResult) => void = () => undefined;

  private readonly paths: OrderPaths;
  private readonly clock: Clock;
  private readonly log: Log;
  private order: Order = {
    title: "",
    context: "",
    planner: { plugin: "", name: "" },
    state: {},
    tasks: [],
  };
  private hash = "";
  private pool = 1;
  private minutes: Minutes = DEFAULT_MINUTES;
  private disallowedTools: readonly string[] = DEFAULT_DISALLOWED_TOOLS;
  private notifiers: Notifier[] = [];
  private readonly notices: Promise<void>[] = [];

  private readonly workers = new Map<string, WorkerRun>();
  private meta: MetaRun | null = null;
  private mode: "running" | "pausing" | "paused" | "stopping" = "running";
  private modeSince = 0;
  private waitingOwnerSince: number | null = null;
  private limitUntil: number | null = null;
  private limitSince: number | null = null;
  private limitTimer: Timer | null = null;
  private limitNotified = false;
  private readonly usageNotified = new Set<string>();
  private readonly deciderTried = new Set<string>();
  private readonly questionsNotified = new Set<string>();
  private replanFailures = 0;
  private haltWhenIdle: RunResult | null = null;
  private halted = false;
  private release: () => void = () => undefined;
  private sessionSeq = 0;

  private readonly options: DispatcherOptions;

  constructor(options: DispatcherOptions) {
    this.options = options;
    this.paths = options.paths ?? orderPaths(options.file);
    this.clock = options.clock ?? systemClock();
    this.log = options.log ?? silentLog;
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  /** Take the lock, read the order, recover what a vanished dispatcher left, and begin. */
  start(): void {
    this.release = acquireLock(this.paths);
    try {
      const text = readOrderText(this.paths.order);
      this.order = parseOrder(text);
      this.hash = textHash(text);
      const missing = this.missingPlugins();
      if (missing.length > 0) {
        throw new OrderError(
          `no model plugin ${missing.join(", ")} (known: ${Object.keys(this.options.hosts).join(", ")})`,
        );
      }
      this.pool = this.options.pool ?? this.order.settings?.pool ?? 1;
      this.minutes = minutesOf(this.order.settings);
      this.disallowedTools = this.order.settings?.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
      this.notifiers = this.options.notifiers?.(this.order) ?? [];
      mkdirSync(this.paths.sessions, { recursive: true });
      this.sessionSeq = readdirSync(this.paths.sessions).length;
      const recovered = recoverOrder(this.order);
      if (recovered !== null) {
        this.log.warn("tasks left running by a dispatcher that is gone are interrupted", {
          tasks: this.order.tasks
            .filter((task) => task.status === "running")
            .map((task) => task.id),
        });
        this.order = recovered;
        this.save();
      }
    } catch (error: unknown) {
      this.release();
      throw error;
    }
    this.modeSince = this.clock.now();
    this.log.info("dispatcher started", { order: this.paths.order, pool: this.pool });
    this.guard(() => {
      this.pump();
    });
  }

  /** Resolves when every notification sent so far has gone out or failed. */
  async drained(): Promise<void> {
    await Promise.allSettled(this.notices);
  }

  handle(request: ControlRequest): ControlResponse {
    try {
      switch (request.cmd) {
        case "status":
          break;
        case "pause":
          this.pause(request.drain);
          break;
        case "resume":
          this.resume();
          break;
        case "stop":
          this.stop();
          break;
        case "answer":
          this.answer(request.id, request.text);
          break;
      }
      return { ok: true, status: this.status() };
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : "failed" };
    }
  }

  /**
   * No new task starts. Without `drain`, every worker is asked to hand in now; a replan that
   * runs or is owed finishes. The process stays and waits for resume or stop.
   */
  pause(drain: boolean): void {
    if (this.halted || this.mode === "stopping") return;
    if (this.mode === "running") {
      this.mode = "pausing";
      this.modeSince = this.clock.now();
      this.log.warn(
        drain ? "pausing after the running tasks" : "pausing: workers asked to hand in",
      );
    }
    if (!drain) {
      for (const run of this.workers.values()) {
        if (run.pauseAsked) continue;
        run.pauseAsked = true;
        run.session.send(PAUSE_TEXT, "now");
      }
    }
    this.guard(() => {
      this.pump();
    });
  }

  resume(): void {
    if (this.halted || (this.mode !== "pausing" && this.mode !== "paused")) return;
    this.mode = "running";
    this.modeSince = this.clock.now();
    this.log.warn("resumed");
    this.guard(() => {
      this.pump();
    });
  }

  /**
   * Close every session now. Running tasks become interrupted and a replan is owed, so the next
   * start begins with the planner.
   */
  stop(): void {
    if (this.halted) return;
    this.mode = "stopping";
    this.log.warn("stopping now");
    this.guard(() => {
      const now = this.clock.now();
      for (const run of [...this.workers.values()]) {
        this.settleWorker(run);
        this.order = updateTask(this.order, run.task.id, (task) => ({
          ...task,
          status: "interrupted",
          report: {
            summary: STOP_SUMMARY,
            proposal: "",
            reason: "stop",
            minutes: minutesSince(run.startedAt, now),
          },
        }));
        this.order = withReplan(this.order, { reason: "interrupted", task: run.task.id, text: "" });
      }
      if (this.meta !== null) this.settleMeta(this.meta);
      this.save();
      this.finish({ reason: "stopped" });
    });
  }

  answer(id: string, text: string): void {
    if (this.halted) throw new OrderError("the dispatcher has stopped");
    this.order = answerQuestion(this.order, id, text, "owner", new Date(this.clock.now()));
    this.log.warn("question answered", { question: id });
    this.guard(() => {
      this.save();
      this.pump();
    });
  }

  status(): StatusReport {
    const now = this.clock.now();
    const idle = this.workers.size === 0 && this.meta === null;
    let mode: Mode = "running";
    let since: number | null = this.modeSince;
    if (this.mode === "stopping" || this.halted) mode = "stopping";
    else if (this.mode === "pausing" || this.mode === "paused") mode = this.mode;
    else if (this.limitUntil !== null) {
      mode = "waiting-limit";
      since = this.limitSince;
    } else if (this.meta?.kind === "planner") {
      mode = "replanning";
      since = this.meta.startedAt;
    } else if (idle && this.waitingOwnerSince !== null) {
      mode = "waiting-owner";
      since = this.waitingOwnerSince;
    }
    const counts = { pending: 0, running: 0, done: 0, failed: 0, blocked: 0, interrupted: 0 };
    for (const task of this.order.tasks) counts[task.status] += 1;
    return {
      title: this.order.title,
      file: this.paths.order,
      pid: process.pid,
      mode,
      since: since === null ? null : new Date(since).toISOString(),
      pool: this.pool,
      counts,
      running: [...this.workers.values()].map((run) => ({
        id: run.task.id,
        title: run.task.title,
        minutes: minutesSince(run.startedAt, now),
      })),
      replan: {
        queued: this.order.replan?.length ?? 0,
        runningMinutes:
          this.meta?.kind === "planner" ? minutesSince(this.meta.startedAt, now) : null,
      },
      questions: openQuestions(this.order).map(({ id, task, text }) => ({ id, task, text })),
      limitUntil: this.limitUntil === null ? null : new Date(this.limitUntil).toISOString(),
      totals: totals(this.order),
    };
  }

  /** Decide what to start next, or whether the run is over. */
  private pump(): void {
    if (this.halted || this.mode === "stopping") return;
    this.notifyQuestions();
    const idle = (): boolean => this.workers.size === 0 && this.meta === null;
    if (this.haltWhenIdle !== null) {
      if (idle()) this.finish(this.haltWhenIdle);
      return;
    }
    if (this.limitUntil !== null) return;
    if (this.meta === null) {
      if ((this.order.replan?.length ?? 0) > 0) this.startPlanner();
      else if (this.order.decider !== undefined) {
        const untried = openQuestions(this.order).filter((q) => !this.deciderTried.has(q.id));
        if (untried.length > 0) this.startDecider(untried.map((q) => q.id));
      }
    }
    if (this.meta === null && this.mode === "running") {
      for (const task of runnableTasks(this.order)) {
        if (this.workers.size >= this.pool) break;
        if (this.workers.has(task.id)) continue;
        this.startWorker(task);
      }
    }
    if (!idle()) {
      this.waitingOwnerSince = null;
      return;
    }
    if (this.mode === "pausing") {
      this.mode = "paused";
      this.modeSince = this.clock.now();
      this.log.warn("paused");
    }
    if (this.mode === "paused") return;
    const pending = pendingTasks(this.order);
    const open = openQuestions(this.order);
    if (pending.length === 0 && open.length === 0) {
      this.finish({ reason: "done" });
      return;
    }
    if (open.length > 0) {
      if (this.waitingOwnerSince === null) {
        this.waitingOwnerSince = this.clock.now();
        this.log.warn("waiting for the owner's answers", { questions: open.map((q) => q.id) });
      }
      return;
    }
    const blockers = backlogBlockers(this.order);
    const waiting = pending[0];
    if (blockers.length > 0 && waiting !== undefined && (this.order.replan?.length ?? 0) === 0) {
      this.order = withReplan(this.order, {
        reason: "stuck",
        task: waiting.id,
        text: blockers.join("\n"),
      });
      this.save();
      this.log.warn("pending tasks wait for tasks that will not be done; replanning");
      this.pump();
      return;
    }
    this.finish({
      reason: "stuck",
      detail: `pending tasks wait for tasks that are not done: ${pending.map((task) => task.id).join(", ")}`,
    });
  }

  private startWorker(task: Task): void {
    const spec = task.model;
    const host = this.host(spec.plugin);
    const running = [...this.workers.values()].map((run) => run.task);
    const prompt = workerPrompt({
      order: this.order,
      task,
      minutes: this.minutes,
      pool: this.pool,
      running,
    });
    this.order = updateTask(this.order, task.id, (item) => {
      const { report: _old, ...rest } = item;
      return { ...rest, status: "running" };
    });
    this.save();
    this.log.info("task started", { task: task.id, model: modelText(spec) });
    const session = host.open(
      this.request("worker", task.id, spec.name, spec.effort, prompt, replySchema(WorkerReply)),
    );
    const run: WorkerRun = {
      task,
      session,
      startedAt: this.clock.now(),
      timers: [],
      settled: false,
      pauseAsked: false,
    };
    const minute = 60_000;
    const send = (text: string, priority: "now" | "next", label: string) => () => {
      this.log.info("time reminder", { task: task.id, at: label });
      session.send(text, priority);
    };
    run.timers.push(
      this.clock.delay(
        this.minutes.remind * minute,
        send(remindText(this.minutes), "next", "remind"),
      ),
      this.clock.delay(this.minutes.wrap * minute, send(wrapText(this.minutes), "now", "wrap")),
      this.clock.delay(
        this.minutes.finish * minute,
        send(finishText(this.minutes), "now", "finish"),
      ),
      this.clock.delay(this.minutes.stop * minute, () => {
        this.guard(() => {
          this.endWorker(run, { kind: "timeout" });
        });
      }),
    );
    this.workers.set(task.id, run);
    session.finished.then(
      (answer) => {
        this.guard(() => {
          this.endWorker(run, { kind: "answer", answer });
        });
      },
      (error: unknown) => {
        this.guard(() => {
          this.endWorker(run, { kind: "error", error });
        });
      },
    );
  }

  private settleWorker(run: WorkerRun): void {
    run.settled = true;
    for (const timer of run.timers) timer.cancel();
    run.session.close();
    this.workers.delete(run.task.id);
  }

  private endWorker(run: WorkerRun, end: WorkerEnd): void {
    if (run.settled) return;
    this.settleWorker(run);
    const id = run.task.id;
    const now = this.clock.now();
    const base = { minutes: minutesSince(run.startedAt, now) };
    let report: TaskReport;
    let status: Task["status"];
    if (end.kind === "timeout") {
      status = "interrupted";
      report = { summary: timeoutSummary(this.minutes), proposal: "", reason: "time", ...base };
      this.order = withReplan(this.order, { reason: "interrupted", task: id, text: "" });
    } else if (end.kind === "error") {
      if (end.error instanceof SessionLimitError) {
        status = "interrupted";
        report = {
          summary: `The usage limit of the account cut the session off at minute ${String(Math.round(base.minutes))}, without a report.`,
          proposal: "",
          reason: "limit",
          ...base,
        };
        this.order = withReplan(this.order, { reason: "limit", task: id, text: "" });
        this.enterLimit(end.error.resetsAt);
      } else {
        status = "failed";
        report = { summary: errorText(end.error), proposal: "", ...base };
        this.order = withReplan(this.order, { reason: "failed", task: id, text: "" });
      }
    } else {
      const extra = withUsage(base, end.answer.usage);
      const reply = parseReply(WorkerReply, end.answer);
      if (reply === null) {
        status = "failed";
        report = { summary: unread(end.answer.text), proposal: "", ...extra };
        this.order = withReplan(this.order, { reason: "failed", task: id, text: "" });
      } else {
        if (reply.statePatch !== undefined) {
          this.order = { ...this.order, state: patchState(this.order.state, reply.statePatch) };
        }
        report = { summary: reply.summary, proposal: reply.proposal, ...extra };
        const note = reply.note?.trim() ?? "";
        if (note !== "") report.note = note;
        const questions = reply.questions ?? [];
        if (reply.outcome === "blocked" && questions.length > 0) {
          status = "blocked";
          this.order = addQuestions(this.order, id, questions, new Date(now));
        } else if (reply.outcome === "done") {
          status = "done";
          if (reply.proposal.trim() !== "") {
            this.order = withReplan(this.order, {
              reason: "proposal",
              task: id,
              text: reply.proposal,
            });
          }
        } else {
          status = "failed";
          if (reply.outcome === "blocked") report.summary += " (blocked, but asked no question)";
          this.order = withReplan(this.order, { reason: "failed", task: id, text: reply.proposal });
        }
      }
    }
    this.order = updateTask(this.order, id, (task) => ({ ...task, status, report }));
    this.save();
    const level = status === "done" ? "info" : "warn";
    this.log[level]("task finished", {
      task: id,
      status,
      reason: report.reason,
      minutes: Math.round(report.minutes ?? 0),
      summary: report.summary,
      proposal: report.proposal,
    });
    this.pump();
  }

  private startPlanner(): void {
    const items = this.order.replan ?? [];
    const spec = this.order.planner;
    const prompt = plannerPrompt({
      order: this.order,
      items,
      minutes: this.minutes,
      pool: this.pool,
    });
    this.log.info("replan started", {
      reasons: items.map((item) => `${item.reason}:${item.task}`),
    });
    const session = this.host(spec.plugin).open(
      this.request("planner", "replan", spec.name, spec.effort, prompt, replySchema(PlannerReply)),
    );
    this.startMeta("planner", session, {
      consumed: items.length,
      questionIds: [],
    });
  }

  private startDecider(questionIds: string[]): void {
    const decider = this.order.decider;
    if (decider === undefined) return;
    const spec = decider;
    const questions = openQuestions(this.order).filter((q) => questionIds.includes(q.id));
    this.log.info("decider started", { questions: questionIds });
    const session = this.host(spec.plugin).open(
      this.request(
        "decider",
        "questions",
        spec.name,
        spec.effort,
        deciderPrompt(this.order, questions),
        replySchema(DeciderReply),
      ),
    );
    this.startMeta("decider", session, { consumed: 0, questionIds });
  }

  private startMeta(
    kind: MetaRun["kind"],
    session: RunningSession,
    data: Pick<MetaRun, "consumed" | "questionIds">,
  ): void {
    const meta: MetaRun = {
      kind,
      session,
      startedAt: this.clock.now(),
      settled: false,
      timer: { cancel: () => undefined },
      ...data,
    };
    meta.timer = this.clock.delay(this.minutes.replan * 60_000, () => {
      this.guard(() => {
        this.endMeta(meta, { kind: "timeout" });
      });
    });
    this.meta = meta;
    session.finished.then(
      (answer) => {
        this.guard(() => {
          this.endMeta(meta, { kind: "answer", answer });
        });
      },
      (error: unknown) => {
        this.guard(() => {
          this.endMeta(meta, { kind: "error", error });
        });
      },
    );
  }

  private settleMeta(meta: MetaRun): void {
    meta.settled = true;
    meta.timer.cancel();
    meta.session.close();
    if (this.meta === meta) this.meta = null;
  }

  private endMeta(meta: MetaRun, end: MetaEnd): void {
    if (meta.settled) return;
    this.settleMeta(meta);
    if (end.kind === "error" && end.error instanceof SessionLimitError) {
      this.log.warn(`usage limit cut the ${meta.kind}; it runs again after the wait`);
      this.enterLimit(end.error.resetsAt);
      this.pump();
      return;
    }
    if (meta.kind === "planner") this.endPlanner(meta, end);
    else this.endDecider(meta, end);
    this.pump();
  }

  private endPlanner(meta: MetaRun, end: MetaEnd): void {
    let problem: string;
    if (end.kind === "timeout")
      problem = `the replan did not finish in ${String(this.minutes.replan)} minutes`;
    else if (end.kind === "error") problem = errorText(end.error);
    else {
      const reply = parseReply(PlannerReply, end.answer);
      if (reply === null) problem = unread(end.answer.text);
      else {
        try {
          const next = applyPlan(this.order, reply, meta.consumed);
          const before = this.order;
          this.order = next;
          const missing = this.missingPlugins();
          if (missing.length > 0) {
            this.order = before;
            throw new OrderError(`no model plugin ${missing.join(", ")}`);
          }
          this.replanFailures = 0;
          this.save();
          this.log.info("backlog patched", { pending: pendingTasks(this.order).length });
          return;
        } catch (error: unknown) {
          if (!(error instanceof OrderError)) throw error;
          problem = `the planner's backlog is not valid: ${error.message}`;
        }
      }
    }
    this.replanFailures += 1;
    this.log.error("replan failed", { problem, attempt: this.replanFailures });
    if (this.replanFailures >= REPLAN_ATTEMPTS) {
      this.log.error("the dispatcher stops once the running tasks are done");
      this.haltWhenIdle = { reason: "replan-failed", detail: problem };
    }
  }

  private endDecider(meta: MetaRun, end: MetaEnd): void {
    for (const id of meta.questionIds) this.deciderTried.add(id);
    if (end.kind !== "answer") {
      this.log.warn("the decider gave no answers; the owner decides", {
        problem: end.kind === "timeout" ? "timeout" : errorText(end.error),
      });
      return;
    }
    const reply = parseReply(DeciderReply, end.answer);
    if (reply === null) {
      this.log.warn("the decider's reply is not readable; the owner decides");
      return;
    }
    const decider =
      this.order.decider === undefined ? "decider" : `decider ${modelText(this.order.decider)}`;
    const open = new Set(openQuestions(this.order).map((q) => q.id));
    for (const item of reply.answers) {
      if (item.answer.trim() === "" || !meta.questionIds.includes(item.id) || !open.has(item.id)) {
        continue;
      }
      this.order = answerQuestion(
        this.order,
        item.id,
        item.answer,
        decider,
        new Date(this.clock.now()),
      );
      this.log.warn("question answered by the decider", { question: item.id, answer: item.answer });
    }
    this.save();
  }

  /** Wait for the usage limit to reset; without a known time, try again after a while. */
  private enterLimit(resetsAt: Date | undefined): void {
    const now = this.clock.now();
    const reset = resetsAt?.getTime();
    const until =
      reset !== undefined && reset > now
        ? reset + LIMIT_GRACE_MS
        : now + this.minutes.limitRetry * 60_000;
    if (this.limitUntil !== null && this.limitUntil >= until) return;
    this.limitTimer?.cancel();
    this.limitUntil = until;
    this.limitSince ??= now;
    const iso = new Date(until).toISOString();
    this.log.warn("usage limit reached: waiting", {
      until: iso,
      known: reset !== undefined && reset > now,
    });
    if (until - now > LONG_LIMIT_MS && !this.limitNotified) {
      this.limitNotified = true;
      this.notify(
        "limit",
        `The usage limit is used up. The dispatcher waits until ${iso} and goes on by itself.`,
      );
    }
    this.limitTimer = this.clock.delay(until - now, () => {
      this.guard(() => {
        this.limitUntil = null;
        this.limitSince = null;
        this.limitTimer = null;
        this.limitNotified = false;
        this.log.info("the usage limit wait is over");
        this.pump();
      });
    });
  }

  private onUsage(window: UsageWindow): void {
    if (!window.type.startsWith("seven_day")) return;
    if (window.utilization === undefined || window.utilization < USAGE_WARNING) return;
    if (this.usageNotified.has(window.type)) return;
    this.usageNotified.add(window.type);
    const percent = Math.round(window.utilization * 100);
    this.log.warn("weekly usage window nearly used up", { window: window.type, percent });
    this.notify(
      "usage",
      `The weekly usage window (${window.type}) is at ${String(percent)} %. When it runs out, the wait can take days.`,
    );
  }

  private notifyQuestions(): void {
    const fresh = openQuestions(this.order).filter((question) => {
      if (this.questionsNotified.has(question.id)) return false;
      // The decider answers first; the owner hears only about what it left.
      return this.order.decider === undefined || this.deciderTried.has(question.id);
    });
    if (fresh.length === 0) return;
    for (const question of fresh) this.questionsNotified.add(question.id);
    const text = fresh
      .map((question) => `${question.id} [${question.task}]: ${question.text}`)
      .join("\n\n");
    this.notify("questions", `${text}\n\nAnswer: ordo answer ${this.paths.order} <id> "<answer>"`);
  }

  private notify(kind: NoticeKind, text: string): void {
    const notice: Notice = { kind, order: this.order.title, text };
    for (const notifier of this.notifiers) {
      this.notices.push(
        notifier.send(notice).then(
          () => {
            this.log.info("notification sent", { via: notifier.name, kind });
          },
          (error: unknown) => {
            this.log.warn("notification failed", {
              via: notifier.name,
              kind,
              error: errorText(error),
            });
          },
        ),
      );
    }
  }

  private finish(result: RunResult): void {
    if (this.halted) return;
    this.halted = true;
    this.limitTimer?.cancel();
    for (const run of [...this.workers.values()]) this.settleWorker(run);
    if (this.meta !== null) this.settleMeta(this.meta);
    const data = result.detail === undefined ? { reason: result.reason } : { ...result };
    if (result.reason === "done" || result.reason === "stopped")
      this.log.warn("dispatcher stopped", data);
    else this.log.error("dispatcher stopped", data);
    if (result.reason === "done") {
      const sum = totals(this.order);
      this.notify(
        "done",
        `All tasks are done: ${String(this.order.tasks.filter((task) => task.status === "done").length)} done, ${String(sum.sessions)} sessions, ${String(sum.minutes)} min.`,
      );
    } else if (result.reason !== "stopped") {
      this.notify(
        "error",
        `${result.reason}${result.detail === undefined ? "" : `: ${result.detail}`}`,
      );
    }
    this.release();
    this.resolveResult(result);
  }

  /** Run an event handler. A conflict or an internal error ends the run. */
  private guard(run: () => void): void {
    if (this.halted) return;
    try {
      run();
    } catch (error: unknown) {
      if (error instanceof ConflictError) {
        const copy = join(this.paths.runDir, "order.conflict.yaml");
        writeFileSync(copy, formatOrder(this.order));
        this.finish({
          reason: "conflict",
          detail: `${error.message}; the dispatcher's version is in ${copy}`,
        });
        return;
      }
      this.finish({ reason: "error", detail: errorText(error) });
    }
  }

  private save(): void {
    if (textHash(readOrderText(this.paths.order)) !== this.hash) throw new ConflictError();
    const text = formatOrder(this.order);
    writeAtomic(this.paths.order, text);
    this.hash = textHash(text);
  }

  private missingPlugins(): string[] {
    return [...orderPlugins(this.order)].filter(
      (plugin) => this.options.hosts[plugin] === undefined,
    );
  }

  private host(plugin: string): SessionHost {
    const host = this.options.hosts[plugin];
    if (host === undefined) throw new OrderError(`no model plugin ${plugin}`);
    return host;
  }

  private request(
    role: SessionRole,
    name: string,
    model: string,
    effort: SessionRequest["effort"],
    prompt: string,
    schema: Record<string, unknown>,
  ): SessionRequest {
    this.sessionSeq += 1;
    const file = join(
      this.paths.sessions,
      `${String(this.sessionSeq).padStart(4, "0")}-${role}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.log`,
    );
    let broken = false;
    const transcript = (line: string): void => {
      if (broken) return;
      try {
        appendFileSync(file, `${new Date(this.clock.now()).toISOString()} ${redact(line)}\n`);
      } catch (error: unknown) {
        broken = true;
        this.log.warn("session transcript is not written", { file, error: errorText(error) });
      }
    };
    for (const line of prompt.split("\n")) transcript(`prompt | ${line}`);
    this.log.debug("session transcript", { file });
    return {
      role,
      model,
      effort,
      cwd: this.options.cwd,
      prompt,
      schema,
      disallowedTools: this.disallowedTools,
      transcript,
      onUsage: (window) => {
        this.guard(() => {
          this.onUsage(window);
        });
      },
    };
  }
}

function minutesSince(start: number, now: number): number {
  return Math.round(((now - start) / 60_000) * 10) / 10;
}

/** Turns always; a dollar cost only when the host reported one. */
function withUsage(
  base: { minutes: number },
  usage: SessionUsage | undefined,
): { minutes: number; turns?: number; costUsd?: number } {
  if (usage === undefined) return base;
  const cost = usage.costUsd;
  return {
    ...base,
    turns: usage.turns,
    ...(cost === undefined ? {} : { costUsd: Math.round(cost * 10_000) / 10_000 }),
  };
}

function parseReply<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  answer: SessionAnswer,
): T | null {
  const value = answer.structured !== undefined ? answer.structured : jsonValue(answer.text);
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function jsonValue(text: string): unknown {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (body === "") return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return value;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function unread(text: string): string {
  const clipped = text.trim().slice(0, 500);
  return clipped === "" ? "the reply is not readable" : `the reply is not readable: ${clipped}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "the session closed without an answer";
}

/** Read an order and run it to the end in this process. */
export async function runOrder(options: DispatcherOptions): Promise<RunResult> {
  const dispatcher = new Dispatcher(options);
  dispatcher.start();
  const result = await dispatcher.result;
  await dispatcher.drained();
  return result;
}

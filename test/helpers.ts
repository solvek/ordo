import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dispatcher, type DispatcherOptions } from "../src/dispatcher.ts";
import { orderPaths } from "../src/files.ts";
import { type Log } from "../src/logger.ts";
import { type Notice, type Notifier } from "../src/notify.ts";
import {
  type Clock,
  type RunningSession,
  type SendPriority,
  type SessionAnswer,
  type SessionHost,
  type SessionRequest,
  type Timer,
} from "../src/session.ts";

/** A clock that moves only when the test says so. */
export class ManualClock implements Clock {
  private current: number;
  private timers: { at: number; run: () => void; cancelled: boolean }[] = [];

  constructor(start = Date.parse("2030-01-01T00:00:00Z")) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  delay(ms: number, run: () => void): Timer {
    const timer = { at: this.current + ms, run, cancelled: false };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  /** Move time forward, running every timer that falls due on the way, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.current = due.at;
      due.run();
      await flush();
    }
    this.current = target;
    await flush();
  }

  async advanceMinutes(minutes: number): Promise<void> {
    await this.advance(minutes * 60_000);
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export interface ScriptedSession {
  request: SessionRequest;
  sent: { text: string; priority: SendPriority }[];
  closed: boolean;
  settled: boolean;
  resolve(answer: SessionAnswer): void;
  reject(error: Error): void;
}

/** A model plugin whose sessions the test answers by hand. */
export class ScriptedHost implements SessionHost {
  readonly sessions: ScriptedSession[] = [];

  open(request: SessionRequest): RunningSession {
    let resolveAnswer: (answer: SessionAnswer) => void = () => undefined;
    let rejectAnswer: (error: Error) => void = () => undefined;
    const finished = new Promise<SessionAnswer>((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    finished.catch(() => undefined);
    const session: ScriptedSession = {
      request,
      sent: [],
      closed: false,
      settled: false,
      resolve: resolveAnswer,
      reject: rejectAnswer,
    };
    this.sessions.push(session);
    return {
      send: (text, priority) => {
        session.sent.push({ text, priority });
      },
      finished,
      close: () => {
        session.closed = true;
        if (session.settled) return;
        session.settled = true;
        session.reject(new Error("closed"));
      },
    };
  }

  /** Sessions still waiting for an answer. */
  open_(): ScriptedSession[] {
    return this.sessions.filter((session) => !session.settled);
  }

  last(): ScriptedSession {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error("no session opened");
    return session;
  }

  roles(): string[] {
    return this.sessions.map((session) => session.request.role);
  }

  answer(structured: unknown, session = this.lastOpen(), usage?: SessionAnswer["usage"]): void {
    if (session.settled) throw new Error("session already settled");
    session.settled = true;
    const answer: SessionAnswer = { text: JSON.stringify(structured), structured };
    if (usage !== undefined) answer.usage = usage;
    session.resolve(answer);
  }

  answerText(text: string, session = this.lastOpen()): void {
    session.settled = true;
    session.resolve({ text, structured: undefined });
  }

  refuse(error: Error, session = this.lastOpen()): void {
    session.settled = true;
    session.reject(error);
  }

  lastOpen(): ScriptedSession {
    const session = this.open_().at(-1);
    if (session === undefined) throw new Error("no open session");
    return session;
  }
}

export class MemoryLog implements Log {
  readonly lines: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  debug = (message: string, data?: Record<string, unknown>): void => {
    this.push("debug", message, data);
  };
  info = (message: string, data?: Record<string, unknown>): void => {
    this.push("info", message, data);
  };
  warn = (message: string, data?: Record<string, unknown>): void => {
    this.push("warn", message, data);
  };
  error = (message: string, data?: Record<string, unknown>): void => {
    this.push("error", message, data);
  };
  private push(level: string, message: string, data?: Record<string, unknown>): void {
    this.lines.push(data === undefined ? { level, message } : { level, message, data });
  }
}

export class MemoryNotifier implements Notifier {
  readonly name = "memory";
  readonly notices: Notice[] = [];
  send(notice: Notice): Promise<void> {
    this.notices.push(notice);
    return Promise.resolve();
  }
}

const dirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ordo-test-"));
  dirs.push(dir);
  return dir;
}

export function cleanTemp(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
}

export function tempOrder(text: string): string {
  const file = join(tempDir(), "order.yaml");
  writeFileSync(file, text);
  return file;
}

export const SMALL = "{ plugin: test, name: small-model }";
export const BIG = "{ plugin: test, name: big-model, effort: medium }";

export function task(id: string, extra = ""): string {
  return `  - id: ${id}
    title: Translate ${id}
    model: ${SMALL}
    prompt: Translate ${id} of the fictional book.
${extra}`;
}

export function orderText(tasks: string, head = ""): string {
  return `title: Fictional book
context: Translate a fictional book chapter by chapter.
planner: ${BIG}
${head}state: {}
tasks:
${tasks}`;
}

export interface Harness {
  file: string;
  host: ScriptedHost;
  clock: ManualClock;
  log: MemoryLog;
  notifier: MemoryNotifier;
  dispatcher: Dispatcher;
}

export function harness(file: string, extra: Partial<DispatcherOptions> = {}): Harness {
  const host = new ScriptedHost();
  const clock = new ManualClock();
  const log = new MemoryLog();
  const notifier = new MemoryNotifier();
  const env = { XDG_RUNTIME_DIR: join(tempDir(), "run") };
  const dispatcher = new Dispatcher({
    file,
    cwd: tempDir(),
    hosts: { test: host },
    clock,
    log,
    notifiers: () => [notifier],
    paths: orderPaths(file, env),
    // Tests do not depend on the free space of the machine.
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    ...extra,
  });
  return { file, host, clock, log, notifier, dispatcher };
}

export async function started(
  file: string,
  extra: Partial<DispatcherOptions> = {},
): Promise<Harness> {
  const h = harness(file, extra);
  h.dispatcher.start();
  await flush();
  return h;
}

export function done(summary = "Translated.", extra: Record<string, unknown> = {}): unknown {
  return { outcome: "done", summary, proposal: "", ...extra };
}

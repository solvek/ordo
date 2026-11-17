// A session the dispatcher keeps open and writes into. A model plugin is a SessionHost;
// tests use their own. Sending after close does nothing.
import { type EffortName } from "./order.ts";

export type SendPriority = "now" | "next";

export type SessionRole = "worker" | "planner" | "decider";

export interface SessionUsage {
  turns: number;
  costUsd: number;
  durationMs: number;
}

export interface SessionAnswer {
  text: string;
  /** Structured output, when the session produced one. */
  structured: unknown;
  usage?: SessionUsage;
}

/**
 * The usage limit of the account cut the session. The task was not judged: it did not fail,
 * it was not allowed to run. `finished` rejects with this error.
 */
export class SessionLimitError extends Error {
  /** When the limit resets, if the host said so. */
  readonly resetsAt: Date | undefined;

  constructor(resetsAt?: Date) {
    super("the usage limit of the account is used up");
    this.name = "SessionLimitError";
    this.resetsAt = resetsAt;
  }
}

/** How full a usage window of the account is, as the host reports it. */
export interface UsageWindow {
  /** For Claude: `five_hour`, `seven_day`, … */
  type: string;
  /** 0..1, when known. */
  utilization: number | undefined;
}

export interface RunningSession {
  send(text: string, priority: SendPriority): void;
  readonly finished: Promise<SessionAnswer>;
  close(): void;
}

export interface SessionRequest {
  role: SessionRole;
  model: string;
  effort: EffortName | undefined;
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  disallowedTools: readonly string[];
  /** One line of the session transcript, without a timestamp. */
  transcript: (line: string) => void;
  /** Usage windows the host learns about while the session runs. */
  onUsage?: (window: UsageWindow) => void;
}

export interface SessionHost {
  open(request: SessionRequest): RunningSession;
}

export interface Timer {
  cancel(): void;
}

export interface Clock {
  delay(ms: number, run: () => void): Timer;
  /** Milliseconds since the epoch. */
  now(): number;
}

export function systemClock(): Clock {
  return {
    now() {
      return Date.now();
    },
    delay(ms, run) {
      // setTimeout cannot wait longer than about 24.8 days in one go.
      const handle = setTimeout(run, Math.min(ms, 2_000_000_000));
      return {
        cancel() {
          clearTimeout(handle);
        },
      };
    },
  };
}

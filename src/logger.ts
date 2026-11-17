// The dispatcher log: pino JSON lines in the order's ordo.log, and short human lines on stderr.
// By default the console shows only warnings and errors.
import { Writable } from "node:stream";
import { pino } from "pino";
import { z } from "zod";
import { redact } from "./transcript.ts";

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

/** What the dispatcher needs from a logger. Tests pass their own. */
export interface Log {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export const silentLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const PINO_LEVELS: Record<number, Level> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LogLine = z.looseObject({ level: z.number(), time: z.number(), msg: z.string().optional() });

/** One pino JSON line as `HH:MM:SS LEVEL message key=value`. Null for a line that is not pino's. */
export function prettyLine(line: string, withDate = false): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = LogLine.safeParse(raw);
  if (!parsed.success) return null;
  const { level, time, msg, pid: _pid, hostname: _host, ...rest } = parsed.data;
  const iso = new Date(time).toISOString();
  const stamp = withDate ? iso.slice(0, 19).replace("T", " ") : iso.slice(11, 19);
  const name = (PINO_LEVELS[level] ?? "info").toUpperCase().padEnd(5);
  const extra = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return `${stamp} ${name} ${msg ?? ""}${extra === "" ? "" : ` ${extra}`}`;
}

function prettyStream(out: NodeJS.WritableStream): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line === "") continue;
        out.write(`${prettyLine(line) ?? line}\n`);
      }
      callback();
    },
  });
}

export interface LoggerOptions {
  file: string;
  fileLevel: Level;
  consoleLevel: Level;
}

export function createLogger(options: LoggerOptions): { log: Log; flush(): void } {
  const fileStream = pino.destination({ dest: options.file, mkdir: true, sync: true });
  const logger = pino(
    {
      level: lowest(options.fileLevel, options.consoleLevel),
      base: { pid: process.pid },
      formatters: { level: (_label, number) => ({ level: number }) },
    },
    pino.multistream([
      { level: options.fileLevel, stream: fileStream },
      { level: options.consoleLevel, stream: prettyStream(process.stderr) },
    ]),
  );
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, data?: Record<string, unknown>): void => {
      const text = redact(message);
      if (data === undefined) logger[level](text);
      else logger[level](redactValue(data), text);
    };
  return {
    log: { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") },
    flush() {
      fileStream.flushSync();
    },
  };
}

function redactValue(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = typeof item === "string" ? redact(item) : item;
  }
  return out;
}

function lowest(a: Level, b: Level): Level {
  return LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b;
}

export function parseLevel(value: string | undefined, fallback: Level): Level {
  if (value === undefined || value === "") return fallback;
  const found = LEVELS.find((level) => level === value.toLowerCase());
  if (found === undefined) throw new Error(`unknown log level ${value} (${LEVELS.join(", ")})`);
  return found;
}

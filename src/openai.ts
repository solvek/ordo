// The `openai` model plugin: one Responses API call per turn, with no tools. A `send` of
// priority `now` aborts the call and asks again; priority `next` waits, then asks again with
// the answer so far (including reasoning items, because the call is stateless). A short rate
// limit is retried here. A quota, or a reset of a minute or more, is a SessionLimitError, so
// the dispatcher waits instead of failing the task.
import { z } from "zod";
import {
  type Clock,
  SessionLimitError,
  type SessionAnswer,
  type SessionHost,
  type SessionRequest,
  systemClock,
} from "./session.ts";
import { prefixed, redact } from "./transcript.ts";

const DEFAULT_BASE = "https://api.openai.com/v1";
/** Attempts at one turn, counting the first. A longer reset is handed to the dispatcher. */
const TRIES = 4;
const SHORT_RESET_MS = 60_000;
const SCHEMA_NAME = "ordo_reply";

/**
 * The session cannot read or write anything. Said once, as instructions, so a reminder turn
 * does not have to repeat it and the dispatcher prompt stays the user message.
 */
const INSTRUCTIONS =
  "You have no tools. You cannot read files, write files or run commands. Answer only from the messages, as the schema requires.";

const QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_usage_limit_exceeded",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
]);

export interface OpenAIFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface OpenAIFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type OpenAIFetch = (url: string, init: OpenAIFetchInit) => Promise<OpenAIFetchResponse>;

export interface OpenAIHostOptions {
  /** Environment the key and the base URL come from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Overrides `OPENAI_BASE_URL`. */
  baseUrl?: string;
  /** HTTP. Tests pass their own; the default is `fetch`. */
  fetch?: OpenAIFetch;
  /** Clock the rate-limit wait uses. Tests pass a manual one. */
  clock?: Clock;
}

type InputItem = Record<string, unknown>;

interface PreparedSchema {
  strict: boolean;
  schema: Record<string, unknown>;
}

interface ModelReply {
  text: string;
  structured: unknown;
  /** Output items to send back on the next turn. */
  output: InputItem[];
}

/** What stops a session before any call. Empty when the environment can call the API. */
export function openaiEnvProblems(env: NodeJS.ProcessEnv, baseUrl?: string): string[] {
  const problems: string[] = [];
  const key = env.OPENAI_API_KEY;
  if (key === undefined || key === "") problems.push("openai: OPENAI_API_KEY is not set");
  const base = baseUrl ?? env.OPENAI_BASE_URL;
  if (base !== undefined && base !== "" && !isHttpUrl(base)) {
    problems.push("openai: OPENAI_BASE_URL is not an http(s) URL");
  }
  return problems;
}

export function openaiHost(options: OpenAIHostOptions = {}): SessionHost {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? fetch;
  const clock = options.clock ?? systemClock();
  return {
    open(request) {
      const log = (line: string): void => {
        request.transcript(redact(line));
      };
      const abort = { current: new AbortController() };
      let history: InputItem[] = [{ role: "user", content: request.prompt }];
      let pending: InputItem[] = [];
      let running = false;
      let closed = false;
      let settled = false;
      let generation = 0;
      let turns = 0;
      const startedAt = clock.now();
      let resolveAnswer: (answer: SessionAnswer) => void = () => undefined;
      let rejectAnswer: (error: Error) => void = () => undefined;
      const finished = new Promise<SessionAnswer>((resolve, reject) => {
        resolveAnswer = resolve;
        rejectAnswer = reject;
      });
      finished.catch(() => undefined);

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        rejectAnswer(error);
      };
      const settle = (reply: ModelReply): void => {
        if (settled) return;
        settled = true;
        resolveAnswer({
          text: reply.text,
          structured: reply.structured,
          usage: { turns, durationMs: Math.max(0, clock.now() - startedAt) },
        });
      };

      const problems = openaiEnvProblems(env, options.baseUrl);
      const key = env.OPENAI_API_KEY ?? "";
      log(
        `session open role=${request.role} model=${request.model} effort=${request.effort ?? "default"} cwd=${request.cwd} tools=none`,
      );
      if (key === "") log("env: OPENAI_API_KEY is not set");
      else log("env: OPENAI_API_KEY is set");

      const turn = (): void => {
        if (closed || settled || running) return;
        if (problems.length > 0) {
          const [first] = problems;
          fail(new Error(first ?? "openai is not configured"));
          return;
        }
        running = true;
        const id = ++generation;
        const input = history;
        abort.current = new AbortController();
        const signal = abort.current.signal;
        let handled = false;
        const finish = (action: () => void): void => {
          if (handled || settled || id !== generation) return;
          handled = true;
          running = false;
          action();
        };
        const url = endpoint(options.baseUrl ?? env.OPENAI_BASE_URL);
        void ask(fetcher, clock, url, key, request, input, signal, log).then(
          (reply) => {
            finish(() => {
              if (closed) {
                fail(new Error("the session was closed"));
                return;
              }
              // The call was aborted, so its body is not part of the next turn. A fetch that
              // already resolved will not also reject, so the continuation happens here too.
              if (signal.aborted) {
                if (pending.length > 0) {
                  history = [...input, ...pending];
                  pending = [];
                  turn();
                }
                return;
              }
              turns += 1;
              for (const line of prefixed("assistant", reply.text)) log(line);
              if (pending.length > 0) {
                history = [...input, ...reply.output, ...pending];
                pending = [];
                turn();
                return;
              }
              settle(reply);
            });
          },
          (error: unknown) => {
            finish(() => {
              if (closed) {
                fail(new Error("the session was closed"));
                return;
              }
              if (isAbort(error) && pending.length > 0) {
                history = [...input, ...pending];
                pending = [];
                turn();
                return;
              }
              if (isAbort(error)) return;
              const text = error instanceof Error ? error.message : "the API call failed";
              log(`session error: ${text}`);
              fail(error instanceof Error ? error : new Error(text));
            });
          },
        );
      };

      if (problems.length === 0) turn();
      else {
        const [first] = problems;
        fail(new Error(first ?? "openai is not configured"));
      }

      return {
        send(text, priority) {
          if (closed || settled) return;
          log(`send priority=${priority}`);
          for (const line of prefixed("send", text)) log(line);
          pending.push({ role: "user", content: text });
          if (!running) {
            history = [...history, ...pending];
            pending = [];
            turn();
            return;
          }
          if (priority === "now") abort.current.abort();
        },
        finished,
        close() {
          if (closed) return;
          closed = true;
          log("session close");
          const wasRunning = running;
          abort.current.abort();
          if (!wasRunning) fail(new Error("the session was closed"));
        },
      };
    },
  };
}

const ErrorBody = z.object({
  message: z.string().optional(),
  type: z.string().optional(),
  code: z.string().optional(),
});

const ApiBody = z.object({
  status: z.string().optional(),
  output: z.array(z.record(z.string(), z.unknown())).optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
  error: ErrorBody.nullable().optional(),
  incomplete_details: z
    .object({
      reason: z.string().optional(),
    })
    .nullable()
    .optional(),
});

async function ask(
  fetcher: OpenAIFetch,
  clock: Clock,
  url: string,
  key: string,
  request: SessionRequest,
  input: readonly InputItem[],
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<ModelReply> {
  const prepared = prepareSchema(request.schema);
  const payload = JSON.stringify(requestPayload(request, input, prepared));
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    log(
      `request model=${request.model} effort=${request.effort ?? "default"} messages=${String(input.length)} strict=${String(prepared.strict)}`,
    );
    const response = await fetcher(url, { method: "POST", headers, body: payload, signal });
    reportUsage(response, request.onUsage, log);
    const raw = await response.text();
    if (response.ok) return readReply(raw, request.schema, prepared.strict, log);
    const failure = httpFailure(response.status, raw);
    const delay = retryDelayMs(response, clock.now());
    if (
      failure.quota ||
      (response.status === 429 && (attempt === TRIES || delay >= SHORT_RESET_MS))
    ) {
      const resetsAt = delay > 0 ? new Date(clock.now() + delay) : undefined;
      log(`limit reached resetsAt=${resetsAt?.toISOString() ?? "?"}`);
      throw new SessionLimitError(resetsAt);
    }
    if ((response.status === 429 || response.status === 503) && attempt < TRIES) {
      const waitMs = delay > 0 ? delay : 1000 * 2 ** (attempt - 1);
      log(`retry status=${String(response.status)} wait=${String(waitMs)}ms`);
      await wait(clock, waitMs, signal);
      continue;
    }
    throw new Error(failure.message);
  }
  throw new Error("the API call failed");
}

function requestPayload(
  request: SessionRequest,
  input: readonly InputItem[],
  prepared: PreparedSchema,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    instructions: INSTRUCTIONS,
    input,
    store: false,
    include: ["reasoning.encrypted_content"],
    text: {
      format: {
        type: "json_schema",
        name: SCHEMA_NAME,
        strict: prepared.strict,
        schema: prepared.schema,
      },
    },
  };
  if (request.effort !== undefined) body.reasoning = { effort: request.effort };
  return body;
}

function readReply(
  raw: string,
  schema: Record<string, unknown>,
  strict: boolean,
  log: (line: string) => void,
): ModelReply {
  const json = readJson(raw);
  const parsed = ApiBody.safeParse(json);
  if (!parsed.success) throw new Error("the API reply is not readable");
  const body = parsed.data;
  const usage = body.usage;
  log(
    `response status=${body.status ?? "ok"} input_tokens=${usage?.input_tokens === undefined ? "?" : String(usage.input_tokens)} output_tokens=${usage?.output_tokens === undefined ? "?" : String(usage.output_tokens)}`,
  );
  if (body.status === "failed" || body.status === "incomplete" || body.status === "cancelled") {
    const detail = body.error?.message ?? body.incomplete_details?.reason ?? body.status;
    throw new Error(`the API response ${body.status}: ${detail}`);
  }
  const output = body.output ?? [];
  const text = messageText(output);
  if (text.refusal !== undefined) throw new Error(text.refusal);
  if (text.text === "") throw new Error("the API returned no text");
  return { text: text.text, structured: structuredOf(text.text, schema, strict), output };
}

function messageText(output: readonly Record<string, unknown>[]): {
  text: string;
  refusal: string | undefined;
} {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isRecord(block)) continue;
      if (block.type === "refusal" && typeof block.refusal === "string") {
        return { text: "", refusal: block.refusal === "" ? "the model refused" : block.refusal };
      }
      if (block.type === "output_text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return { text: parts.join(""), refusal: undefined };
}

function structuredOf(text: string, schema: Record<string, unknown>, strict: boolean): unknown {
  const value = readJson(text);
  if (value === undefined) return undefined;
  return strict ? omitNullOptionals(value, schema) : value;
}

function httpFailure(status: number, raw: string): { message: string; quota: boolean } {
  const json = readJson(raw);
  const parsed = z.object({ error: ErrorBody.optional() }).safeParse(json);
  const error = parsed.success ? parsed.data.error : undefined;
  const quota =
    (error?.type !== undefined && QUOTA_CODES.has(error.type)) ||
    (error?.code !== undefined && QUOTA_CODES.has(error.code));
  const detail = error?.message ?? clip(raw);
  const message =
    detail === ""
      ? `the API answered ${String(status)}`
      : `the API answered ${String(status)}: ${detail}`;
  return { message: redact(message), quota };
}

function reportUsage(
  response: OpenAIFetchResponse,
  onUsage: SessionRequest["onUsage"],
  log: (line: string) => void,
): void {
  const windows: readonly (readonly [string, string, string])[] = [
    ["requests", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests"],
    ["tokens", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens"],
  ];
  for (const [type, limitName, remainingName] of windows) {
    const limit = response.headers.get(limitName);
    const remaining = response.headers.get(remainingName);
    const utilization = ratio(limit, remaining);
    if (utilization === undefined) continue;
    log(`usage ${type} remaining=${remaining ?? "?"} limit=${limit ?? "?"}`);
    onUsage?.({ type, utilization });
  }
}

function ratio(limit: string | null, remaining: string | null): number | undefined {
  if (limit === null || remaining === null) return undefined;
  const max = Number(limit);
  const left = Number(remaining);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(left)) return undefined;
  return Math.min(1, Math.max(0, (max - left) / max));
}

/** Milliseconds until a retry, from Retry-After or the rate-limit reset headers. 0 when unknown. */
function retryDelayMs(response: OpenAIFetchResponse, now: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const parsed = delayMs(retryAfter, now);
    if (parsed !== undefined) return parsed;
  }
  const known = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
    .map((name) => durationMs(response.headers.get(name) ?? ""))
    .filter((value) => value !== undefined);
  const longest = known.reduce((max, value) => (value > max ? value : max), 0);
  return longest;
}

function delayMs(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const dated = Date.parse(trimmed);
  if (!Number.isNaN(dated)) return Math.max(0, dated - now);
  return durationMs(trimmed);
}

/** OpenAI's reset header: `1s`, `6m0s`, `1h30m15s`, `120ms`. */
function durationMs(value: string): number | undefined {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = match[1];
  const minutes = match[2];
  const seconds = match[3];
  const millis = match[4];
  if (
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined &&
    millis === undefined
  ) {
    return undefined;
  }
  return (
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1000 +
    Number(millis ?? 0)
  );
}

function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = clock.delay(ms, () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    const onAbort = (): void => {
      timer.cancel();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function endpoint(base: string | undefined): string {
  const root = base === undefined || base === "" ? DEFAULT_BASE : base;
  return `${root.replace(/\/+$/, "")}/responses`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function clip(text: string): string {
  const trimmed = text.trim().replaceAll("\n", " ");
  if (trimmed.length <= 300) return trimmed;
  return `${trimmed.slice(0, 300)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Strict structured output rejects optional fields and free-form objects. A schema Ordo already
 * uses (a state map, an optional question list) is sent non-strict, and the dispatcher checks
 * it. A schema that can be strict is rewritten so every field is required, with null for the
 * ones that were optional.
 */
function prepareSchema(schema: Record<string, unknown>): PreparedSchema {
  if (!canBeStrict(schema)) return { strict: false, schema: loosen(schema) };
  return { strict: true, schema: strictify(schema) };
}

function canBeStrict(schema: Record<string, unknown>): boolean {
  const extra = schema.additionalProperties;
  if (extra !== undefined && extra !== false) return false;
  if (isRecord(schema.items) && !canBeStrict(schema.items)) return false;
  if (isRecord(schema.properties)) {
    for (const value of Object.values(schema.properties)) {
      if (isRecord(value) && !canBeStrict(value)) return false;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    for (const value of schema.anyOf) {
      if (isRecord(value) && !canBeStrict(value)) return false;
    }
  }
  return true;
}

function strictify(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === "array" && isRecord(schema.items)) {
    return { ...copyOf(schema, ["propertyNames"]), items: strictify(schema.items) };
  }
  if (schema.type !== "object" || !isRecord(schema.properties))
    return copyOf(schema, ["propertyNames"]);
  const required = new Set(stringList(schema.required));
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (!isRecord(value)) continue;
    const child = strictify(value);
    properties[key] = required.has(key) ? child : { anyOf: [child, { type: "null" }] };
  }
  const next: Record<string, unknown> = {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
  if (typeof schema.description === "string") next.description = schema.description;
  return next;
}

function loosen(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = copyOf(schema, ["propertyNames"]);
  if (isRecord(copy.additionalProperties) && Object.keys(copy.additionalProperties).length === 0) {
    copy.additionalProperties = true;
  }
  if (isRecord(copy.items)) copy.items = loosen(copy.items);
  if (!isRecord(copy.properties)) return copy;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(copy.properties)) {
    properties[key] = isRecord(value) ? loosen(value) : value;
  }
  copy.properties = properties;
  return copy;
}

/** Nulls the strict schema used for optional fields are absences in the original schema. */
function omitNullOptionals(value: unknown, schema: Record<string, unknown>): unknown {
  if (Array.isArray(value) && schema.type === "array" && isRecord(schema.items)) {
    const items = schema.items;
    return value.map((item) => omitNullOptionals(item, items));
  }
  if (!isRecord(value) || schema.type !== "object" || !isRecord(schema.properties)) return value;
  const properties = schema.properties;
  const required = new Set(stringList(schema.required));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!required.has(key) && child === null) continue;
    const property = properties[key];
    result[key] = isRecord(property) ? omitNullOptionals(child, property) : child;
  }
  return result;
}

function copyOf(schema: Record<string, unknown>, drop: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!drop.includes(key)) copy[key] = value;
  }
  return copy;
}

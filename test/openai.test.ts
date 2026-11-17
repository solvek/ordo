import { describe, expect, it } from "vitest";
import { DeciderReply, WorkerReply, replySchema } from "../src/order.ts";
import {
  type OpenAIFetch,
  type OpenAIFetchInit,
  type OpenAIFetchResponse,
  openaiHost,
} from "../src/openai.ts";
import {
  type Clock,
  SessionLimitError,
  type SessionRequest,
  type UsageWindow,
} from "../src/session.ts";
import { ManualClock, flush } from "./helpers.ts";

const KEY = "sk-test-secret";
const PROMPT = "Do the task.";

interface Seen {
  url: string;
  init: OpenAIFetchInit;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyOf(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("body is not an object");
  return value;
}

function http(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): OpenAIFetchResponse {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function message(text: string): Record<string, unknown>[] {
  return [
    { type: "reasoning", id: "rs_1", summary: [] },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  ];
}

function completed(text: string, output = message(text)): unknown {
  return {
    status: "completed",
    output,
    usage: { input_tokens: 11, output_tokens: 5 },
  };
}

function answered(fetcher: OpenAIFetch, schema: Record<string, unknown>, clock?: Clock) {
  const lines: string[] = [];
  const usage: UsageWindow[] = [];
  const seen: Seen[] = [];
  const wrapped: OpenAIFetch = (url, init) => {
    seen.push({ url, init, body: bodyOf(init.body) });
    return fetcher(url, init);
  };
  const host = openaiHost({
    env: { OPENAI_API_KEY: KEY },
    fetch: wrapped,
    ...(clock === undefined ? {} : { clock }),
  });
  const request: SessionRequest = {
    role: "worker",
    model: "gpt-test",
    effort: "high",
    cwd: "/work",
    prompt: PROMPT,
    schema,
    disallowedTools: [],
    transcript: (line) => {
      lines.push(line);
    },
    onUsage: (window) => {
      usage.push(window);
    },
  };
  return { session: host.open(request), lines, usage, seen, host };
}

const answerSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string" },
    note: { type: "string", description: "Omit when there is nothing to add." },
  },
};

describe("openai host", () => {
  it("asks the Responses API and returns the structured reply", async () => {
    const text = JSON.stringify({
      outcome: "done",
      summary: "Wrote it.",
      proposal: "",
      statePatch: { n: null },
    });
    const { session, lines, seen } = answered(
      () => Promise.resolve(http(200, completed(text))),
      replySchema(WorkerReply),
      new ManualClock(),
    );
    const answer = await session.finished;
    expect(answer.structured).toEqual({
      outcome: "done",
      summary: "Wrote it.",
      proposal: "",
      statePatch: { n: null },
    });
    expect(answer.usage).toEqual({ turns: 1, durationMs: 0 });
    expect(answer.usage?.costUsd).toBeUndefined();
    const call = seen[0];
    if (call === undefined) throw new Error("no call");
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toMatchObject({
      model: "gpt-test",
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
      input: [{ role: "user", content: PROMPT }],
    });
    expect(call.body.instructions).toContain("no tools");
    const format = call.body.text;
    if (!isRecord(format) || !isRecord(format.format)) throw new Error("no format");
    expect(format.format.strict).toBe(false);
    expect(JSON.stringify(format.format.schema)).not.toContain("propertyNames");
    expect(JSON.stringify(format.format.schema)).toContain('"additionalProperties":true');
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).toContain("tools=none");
    expect(lines.join("\n")).toContain("Wrote it.");
  });

  it("sends a strict schema when every field can be required", async () => {
    const text = JSON.stringify({ answers: [{ id: "q1", answer: "yes" }] });
    const { session, seen } = answered(
      () => Promise.resolve(http(200, completed(text))),
      replySchema(DeciderReply),
    );
    await session.finished;
    const format = seen[0]?.body.text;
    if (!isRecord(format) || !isRecord(format.format)) throw new Error("no format");
    expect(format.format).toMatchObject({ type: "json_schema", name: "ordo_reply", strict: true });
  });

  it("drops nulls that stand in for optional fields", async () => {
    const { session, seen } = answered(
      () => Promise.resolve(http(200, completed(JSON.stringify({ answer: "yes", note: null })))),
      answerSchema,
    );
    const answer = await session.finished;
    expect(answer.structured).toEqual({ answer: "yes" });
    const format = seen[0]?.body.text;
    if (!isRecord(format) || !isRecord(format.format) || !isRecord(format.format.schema)) {
      throw new Error("no schema");
    }
    expect(format.format.schema.required).toEqual(["answer", "note"]);
  });

  it("waits for a next message and sends the answer so far with it", async () => {
    let calls = 0;
    let resolveFirst: (response: OpenAIFetchResponse) => void = () => undefined;
    const output = message(JSON.stringify({ answer: "part" }));
    const { session, seen } = answered(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(http(200, completed(JSON.stringify({ answer: "done" }))));
    }, answerSchema);
    await flush();
    expect(seen).toHaveLength(1);
    session.send("A reminder.", "next");
    await flush();
    expect(seen).toHaveLength(1);
    resolveFirst(http(200, completed(JSON.stringify({ answer: "part" }), output)));
    const answer = await session.finished;
    expect(answer.structured).toEqual({ answer: "done" });
    expect(answer.usage?.turns).toBe(2);
    expect(seen[1]?.body.input).toEqual([
      { role: "user", content: PROMPT },
      ...output,
      { role: "user", content: "A reminder." },
    ]);
  });

  it("aborts the current call when the message cannot wait", async () => {
    let calls = 0;
    const { session, seen } = answered((_url, init) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return Promise.resolve(http(200, completed(JSON.stringify({ answer: "now" }))));
    }, answerSchema);
    await flush();
    session.send("Hand in.", "now");
    const answer = await session.finished;
    expect(answer.structured).toEqual({ answer: "now" });
    expect(answer.usage?.turns).toBe(1);
    expect(seen[0]?.init.signal.aborted).toBe(true);
    expect(seen[1]?.body.input).toEqual([
      { role: "user", content: PROMPT },
      { role: "user", content: "Hand in." },
    ]);
  });

  it("rejects when the session is closed", async () => {
    const { session, seen } = answered((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }, answerSchema);
    await flush();
    session.close();
    await expect(session.finished).rejects.toThrow("the session was closed");
    expect(seen[0]?.init.signal.aborted).toBe(true);
    session.send("later", "now");
    session.close();
    expect(seen).toHaveLength(1);
  });

  it("fails before calling when the key or the base URL is missing", async () => {
    const fetcher: OpenAIFetch = () => Promise.reject(new Error("called"));
    const missing = openaiHost({ env: {}, fetch: fetcher }).open(bare(answerSchema));
    await expect(missing.finished).rejects.toThrow("OPENAI_API_KEY is not set");
    const bad = openaiHost({
      env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: "not a url" },
      fetch: fetcher,
    }).open(bare(answerSchema));
    await expect(bad.finished).rejects.toThrow("OPENAI_BASE_URL");
  });

  it("uses OPENAI_BASE_URL", async () => {
    const seen: string[] = [];
    const host = openaiHost({
      env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: "http://127.0.0.1:9/v1/" },
      fetch: (url) => {
        seen.push(url);
        return Promise.resolve(http(200, completed(JSON.stringify({ answer: "yes" }))));
      },
    });
    await host.open(bare(answerSchema)).finished;
    expect(seen).toEqual(["http://127.0.0.1:9/v1/responses"]);
  });

  it("retries a short rate limit and then takes the reply", async () => {
    const clock = new ManualClock();
    let calls = 0;
    const { session } = answered(
      (_url, _init) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            http(
              429,
              { error: { message: "slow", type: "rate_limit_error", code: "rate_limit_exceeded" } },
              {
                "retry-after": "2",
              },
            ),
          );
        }
        return Promise.resolve(http(200, completed(JSON.stringify({ answer: "yes" }))));
      },
      answerSchema,
      clock,
    );
    await flush();
    expect(calls).toBe(1);
    await clock.advance(1999);
    expect(calls).toBe(1);
    await clock.advance(1);
    const answer = await session.finished;
    expect(answer.structured).toEqual({ answer: "yes" });
    expect(calls).toBe(2);
  });

  it("retries a model overload with a fixed delay", async () => {
    const clock = new ManualClock();
    let calls = 0;
    const { session } = answered(
      () => {
        calls += 1;
        if (calls === 1)
          return Promise.resolve(
            http(503, { error: { message: "busy", code: "server_is_overloaded" } }),
          );
        return Promise.resolve(http(200, completed(JSON.stringify({ answer: "yes" }))));
      },
      answerSchema,
      clock,
    );
    await flush();
    expect(calls).toBe(1);
    await clock.advance(1000);
    await session.finished;
    expect(calls).toBe(2);
  });

  it("treats a long reset as the usage limit", async () => {
    const clock = new ManualClock();
    const { session, seen } = answered(
      () =>
        Promise.resolve(
          http(
            429,
            { error: { message: "later", type: "rate_limit_error" } },
            {
              "x-ratelimit-reset-requests": "6m0s",
            },
          ),
        ),
      answerSchema,
      clock,
    );
    const error = await session.finished.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SessionLimitError);
    if (!(error instanceof SessionLimitError)) return;
    expect(error.resetsAt?.toISOString()).toBe("2030-01-01T00:06:00.000Z");
    expect(seen).toHaveLength(1);
  });

  it("does not retry a quota error", async () => {
    const { session, seen } = answered(
      () =>
        Promise.resolve(
          http(429, {
            error: {
              message: "no credit",
              type: "insufficient_quota",
              code: "credit_balance_exhausted",
            },
          }),
        ),
      answerSchema,
    );
    const error = await session.finished.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SessionLimitError);
    if (!(error instanceof SessionLimitError)) return;
    expect(error.resetsAt).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("reports how full the request and token windows are", async () => {
    const { session, usage } = answered(
      () =>
        Promise.resolve(
          http(200, completed(JSON.stringify({ answer: "yes" })), {
            "x-ratelimit-limit-requests": "100",
            "x-ratelimit-remaining-requests": "25",
            "x-ratelimit-limit-tokens": "1000",
            "x-ratelimit-remaining-tokens": "100",
          }),
        ),
      answerSchema,
    );
    await session.finished;
    expect(usage).toEqual([
      { type: "requests", utilization: 0.75 },
      { type: "tokens", utilization: 0.9 },
    ]);
  });

  it("fails on a refusal, an unread reply and an HTTP error", async () => {
    const refused = openaiHost({
      env: { OPENAI_API_KEY: KEY },
      fetch: () =>
        Promise.resolve(
          http(200, {
            status: "completed",
            output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
          }),
        ),
    }).open(bare(answerSchema));
    await expect(refused.finished).rejects.toThrow("no");

    const unread = openaiHost({
      env: { OPENAI_API_KEY: KEY },
      fetch: () => Promise.resolve(http(200, "not json")),
    }).open(bare(answerSchema));
    await expect(unread.finished).rejects.toThrow("not readable");

    const denied = openaiHost({
      env: { OPENAI_API_KEY: KEY },
      fetch: () => Promise.resolve(http(401, { error: { message: "bad key" } })),
    }).open(bare(answerSchema));
    await expect(denied.finished).rejects.toThrow("the API answered 401: bad key");
  });
});

function bare(schema: Record<string, unknown>): SessionRequest {
  return {
    role: "worker",
    model: "gpt-test",
    effort: undefined,
    cwd: "/work",
    prompt: PROMPT,
    schema,
    disallowedTools: [],
    transcript: () => undefined,
  };
}

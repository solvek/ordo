import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionEnv } from "../src/claude.ts";
import { sendControl, serveControl, statusFromReply } from "../src/control.ts";
import { prettyLine } from "../src/logger.ts";
import { type FetchLike, commandPlugin, createNotifiers, telegramPlugin } from "../src/notify.ts";
import { DEFAULT_MINUTES, parseOrder } from "../src/order.ts";
import { plannerPrompt, workerPrompt } from "../src/prompts.ts";
import { fileStatus } from "../src/status.ts";
import { contentLines, prefixed, redact } from "../src/transcript.ts";
import { cleanTemp, orderText, task, tempDir, tempOrder } from "./helpers.ts";

afterEach(cleanTemp);

describe("workerPrompt", () => {
  it("forbids editing the order, shows the backlog and the report fields", () => {
    const order = parseOrder(orderText(`${task("ch1")}${task("ch2", "    after: [ch1]\n")}`));
    const [first] = order.tasks;
    if (first === undefined) throw new Error("no task");
    const text = workerPrompt({
      order,
      task: first,
      minutes: DEFAULT_MINUTES,
      pool: 1,
      running: [],
    });
    expect(text).toContain("Do not edit the order file");
    expect(text).toContain("Your task: ch1. Translate ch1");
    expect(text).toContain("- id: ch2");
    expect(text).toContain("after: [ch1]");
    expect(text).toContain("statePatch");
    expect(text).toContain("note");
    expect(text).toContain("nothing may keep running in the background");
    expect(text).toContain("Do not check the clock");
    expect(text).toContain("Stop for time only in reply");
    expect(text).not.toContain("Up to");
  });

  it("tells the planner why it is called and which model it is", () => {
    const order = parseOrder(
      orderText(
        task("ch1", "    status: done\n    report: { summary: Done well., proposal: add ch2 }\n"),
      ),
    );
    const text = plannerPrompt({
      order,
      items: [{ reason: "proposal", task: "ch1", text: "add ch2" }],
      minutes: DEFAULT_MINUTES,
      pool: 3,
    });
    expect(text).toContain("Task ch1 (Translate ch1) is done. Its worker proposes:\nadd ch2");
    expect(text).toContain("You run as big-model (medium) via test");
    expect(text).toContain("- small-model via test");
    expect(text).toContain("Up to 3 tasks run at the same time");
    expect(text).toContain("upsert");
    expect(text).toContain("never becomes done");
    expect(text).toContain("summary: Done well.");
  });
});

describe("transcript", () => {
  it("cuts key-shaped secrets and keeps the rest of the line", () => {
    expect(redact("key sk-ant-api03-AbC_1-x end")).toBe("key sk-… end");
    expect(redact("key sk-proj-abc_123 end")).toBe("key sk-… end");
    expect(redact("ANTHROPIC_API_KEY=abc123 next")).toBe("ANTHROPIC_API_KEY=… next");
    expect(redact("OPENAI_API_KEY=sk-proj-abc next")).toBe("OPENAI_API_KEY=… next");
    expect(redact("Authorization: Bearer xyz.abc")).toBe("Authorization: Bearer …");
    expect(redact("https://api.telegram.org/bot123:AA-bb_cc/sendMessage")).toBe(
      "https://api.telegram.org/bot…/sendMessage",
    );
  });

  it("writes each block of a message on its own lines", () => {
    expect(prefixed("text", "a\r\nb")).toEqual(["text: a", "text: b"]);
    expect(prefixed("text", "")).toEqual(["text: (empty)"]);
    expect(
      contentLines([
        { type: "thinking", thinking: "hm" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } },
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: true,
          content: [{ type: "text", text: "no" }],
        },
      ]),
    ).toEqual(["thinking: hm", 'tool Read t1: {"path":"/x"}', "result error t1: no"]);
  });
});

describe("session env", () => {
  it("drops the API key unless asked, and names the client", () => {
    const env = sessionEnv({ ANTHROPIC_API_KEY: "k", PATH: "/bin" }, false);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("ordo");
    expect(sessionEnv({ ANTHROPIC_API_KEY: "k" }, true).ANTHROPIC_API_KEY).toBe("k");
  });
});

describe("notifiers", () => {
  it("sends a Telegram message to the chat from the environment", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({ url, body: init.body });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    };
    const notifier = telegramPlugin.create(
      { plugin: "telegram" },
      { env: { TELEGRAM_BOT_TOKEN: "1:abc", TELEGRAM_CHAT_ID: "42" }, fetch },
    );
    await notifier.send({ kind: "questions", order: "Book", text: "q1: which?" });
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot1:abc/sendMessage");
    const body: unknown = JSON.parse(calls[0]?.body ?? "");
    expect(body).toEqual({
      chat_id: "42",
      text: "Ordo · Book\nQuestions to the owner\n\nq1: which?",
    });
  });

  it("refuses a Telegram notifier without its environment, and an unknown plugin", () => {
    expect(() => createNotifiers([{ plugin: "telegram" }], { env: {} })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
    expect(() =>
      createNotifiers([{ plugin: "telegram", chatEnv: "MY_CHAT" }], {
        env: { TELEGRAM_BOT_TOKEN: "x" },
      }),
    ).toThrow(/MY_CHAT/);
    expect(() => createNotifiers([{ plugin: "pigeon" }], { env: {} })).toThrow(
      /no notifier plugin pigeon/,
    );
  });

  it("runs a command with the text on stdin", async () => {
    const out = join(tempDir(), "notice.txt");
    const notifier = commandPlugin.create(
      { plugin: "command", command: `cat > ${out}; echo "$ORDO_NOTICE_KIND" >> ${out}` },
      { env: { PATH: process.env.PATH ?? "" } },
    );
    await notifier.send({ kind: "done", order: "Book", text: "All done." });
    expect(readFileSync(out, "utf8")).toBe("Ordo · Book\nOrder done\n\nAll done.done\n");
    const failing = commandPlugin.create({ plugin: "command", command: "exit 3" }, { env: {} });
    await expect(failing.send({ kind: "done", order: "Book", text: "x" })).rejects.toThrow(
      /exited 3/,
    );
  });

  it("reports the exit code when the command closes stdin unread", async () => {
    const notifier = commandPlugin.create({ plugin: "command", command: "exit 3" }, { env: {} });
    await expect(
      notifier.send({ kind: "error", order: "Book", text: "x".repeat(1024 * 1024) }),
    ).rejects.toThrow(/exited 3/);
  });
});

describe("status of an order", () => {
  it("shows the live dispatcher status, not the file-only one, when the socket answers", () => {
    const order = parseOrder(orderText(task("ch1")));
    const live = { ...fileStatus(order, "f"), mode: "running" as const, pid: 4242, pool: 1 };
    const report = statusFromReply(order, "f", { ok: true, status: live });
    expect(report.mode).toBe("running");
    expect(report.pid).toBe(4242);
  });

  it("falls back to the file status when no dispatcher answers", () => {
    const order = parseOrder(orderText(task("ch1")));
    expect(statusFromReply(order, "f", null).mode).toBe("not-running");
    expect(statusFromReply(order, "f", { ok: false, error: "busy" }).mode).toBe("not-running");
  });
});

describe("control socket", () => {
  it("carries one request and one response, and reports no listener as null", async () => {
    const socket = join(tempDir(), "s.sock");
    expect(await sendControl(socket, { cmd: "status" })).toBeNull();
    const order = parseOrder(orderText(task("ch1")));
    const close = await serveControl(socket, (request) =>
      request.cmd === "stop"
        ? { ok: false, error: "no" }
        : { ok: true, status: fileStatus(order, "f") },
    );
    try {
      const status = await sendControl(socket, { cmd: "status" });
      expect(status?.ok === true && status.status.counts.pending).toBe(1);
      expect(await sendControl(socket, { cmd: "stop" })).toEqual({ ok: false, error: "no" });
      await expect(serveControl(socket, () => ({ ok: false, error: "" }))).rejects.toThrow(
        /another dispatcher/,
      );
    } finally {
      close();
    }
  });
});

describe("log lines", () => {
  it("prints a pino line for people", () => {
    const line = JSON.stringify({
      level: 40,
      time: Date.parse("2030-01-01T10:20:30Z"),
      pid: 1,
      msg: "paused",
      task: "ch1",
    });
    expect(prettyLine(line)).toBe("10:20:30 WARN  paused task=ch1");
    expect(prettyLine("not json")).toBeNull();
  });
});

describe("cli", () => {
  const cli = resolve("src/cli.ts");
  const ordo = (args: string[], cwd: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", XDG_RUNTIME_DIR: join(cwd, "run"), ...env },
    });

  it("checks the examples", () => {
    for (const example of ["translate-book.yaml", "tidy-notes.yaml"]) {
      const result = ordo(["check", resolve("examples", example)], tempDir(), {
        TELEGRAM_BOT_TOKEN: "1:x",
        TELEGRAM_CHAT_ID: "1",
      });
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("ok");
      expect(result.status).toBe(0);
    }
  });

  it("reports what is wrong with an order", () => {
    const file = tempOrder(orderText(task("ch1")).replace("plugin: test", "plugin: elsewhere"));
    const result = ordo(["check", file], tempDir());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no model plugin elsewhere");
  });

  it("requires the OpenAI key when the order uses that plugin", () => {
    const file = tempOrder(orderText(task("ch1")).replaceAll("plugin: test", "plugin: openai"));
    const missing = ordo(["check", file], tempDir());
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("OPENAI_API_KEY is not set");
    const present = ordo(["check", file], tempDir(), { OPENAI_API_KEY: "sk-test" });
    expect(present.stderr).toBe("");
    expect(present.status).toBe(0);
    const badBase = ordo(["check", file], tempDir(), {
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "not a url",
    });
    expect(badBase.status).toBe(1);
    expect(badBase.stderr).toContain("OPENAI_BASE_URL is not an http(s) URL");
  });

  it("answers a question in the file when no dispatcher runs", () => {
    const file = tempOrder(
      orderText(task("ch1", "    status: blocked\n")).replace(
        "state: {}",
        'state: {}\nquestions:\n  - { id: q1, task: ch1, text: Which?, askedAt: "2030-01-01T00:00:00.000Z" }',
      ),
    );
    const result = ordo(["answer", file, "q1", "The", "first", "one"], tempDir());
    expect(result.stderr).toBe("");
    const order = parseOrder(readFileSync(file, "utf8"));
    expect(order.questions?.[0]).toMatchObject({ answer: "The first one", answeredBy: "owner" });
    expect(order.replan?.[0]?.reason).toBe("answers");
  });

  it("shows the status from the file and says when nothing runs", () => {
    const file = tempOrder(orderText(`${task("ch1", "    status: done\n")}${task("ch2")}`));
    const cwd = tempDir();
    expect(ordo(["status", file], cwd).stdout).toContain("mode: not-running");
    expect(ordo(["status", file], cwd).stdout).toContain("tasks: pending 1, done 1");
    expect(ordo(["pause", file], cwd).stderr).toContain("no dispatcher runs");
    expect(ordo(["list"], cwd).stdout).toBe("no dispatcher is running\n");
  });

  it("prints help", () => {
    expect(execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" })).toContain(
      "ordo start",
    );
  });
});

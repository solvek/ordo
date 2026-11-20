import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { orderPaths } from "../src/files.ts";
import { type Order } from "../src/order.ts";
import { PAUSE_TEXT } from "../src/prompts.ts";
import { SessionLimitError } from "../src/session.ts";
import { readStored } from "../src/store.ts";
import {
  BIG,
  SMALL,
  ScriptedHost,
  cleanTemp,
  done,
  flush,
  harness,
  orderText,
  started,
  task,
  tempOrder,
} from "./helpers.ts";

afterEach(cleanTemp);

function saved(file: string): Order {
  return readStored(orderPaths(file)).order;
}

function statuses(file: string): string[] {
  return saved(file).tasks.map((item) => `${item.id}:${item.status}`);
}

const backlogTask = (id: string, after?: string[]): Record<string, unknown> => ({
  id,
  title: `Translate ${id}`,
  model: { plugin: "test", name: "small-model" },
  prompt: `Translate ${id}.`,
  ...(after === undefined ? {} : { after }),
});

describe("dispatcher: the loop", () => {
  it("runs task after task without a replan when the proposals are empty", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    expect(statuses(file)).toEqual(["ch1:running", "ch2:pending"]);
    h.host.answer(done("Chapter 1.", { statePatch: { chapter: 1 } }), undefined, {
      turns: 7,
      costUsd: 0.12345,
      durationMs: 1000,
    });
    await flush();
    expect(statuses(file)).toEqual(["ch1:done", "ch2:running"]);
    h.host.answer(done("Chapter 2.", { statePatch: { chapter: 2, extra: true } }));
    const result = await h.dispatcher.result;
    expect(result).toEqual({ reason: "done" });
    expect(h.host.roles()).toEqual(["worker", "worker"]);
    const order = saved(file);
    expect(order.state).toEqual({ chapter: 2, extra: true });
    expect(order.tasks[0]?.report).toMatchObject({
      summary: "Chapter 1.",
      turns: 7,
      costUsd: 0.1235,
    });
    expect(h.notifier.notices.map((notice) => notice.kind)).toEqual(["done"]);
    expect(existsSync(orderPaths(file).lock)).toBe(false);
  });

  it("stores a note without a replan and starts the next worker", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    h.host.answer(done("Chapter 1.", { note: "glossary: Colour", proposal: "" }));
    await flush();
    expect(saved(file).tasks[0]?.report?.note).toBe("glossary: Colour");
    expect(saved(file).replan).toBeUndefined();
    expect(statuses(file)).toEqual(["ch1:done", "ch2:running"]);
    expect(h.host.lastOpen().request.role).toBe("worker");
  });

  it("asks the planner to replace the backlog when a worker proposes a change", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    h.host.answer(done("Translated.", { proposal: "Split ch2 in two." }));
    await flush();
    const planner = h.host.lastOpen();
    expect(planner.request.role).toBe("planner");
    expect(planner.request.model).toBe("big-model");
    expect(planner.request.prompt).toContain("Split ch2 in two.");
    expect(planner.request.prompt).toContain("You run as big-model (medium) via test");
    expect(saved(file).replan).toEqual([
      { reason: "proposal", task: "ch1", text: "Split ch2 in two." },
    ]);
    h.host.answer({
      statePatch: { split: true },
      remove: ["ch2"],
      upsert: [backlogTask("ch2a"), backlogTask("ch2b", ["ch2a"])],
      order: ["ch2a", "ch2b"],
    });
    await flush();
    expect(statuses(file)).toEqual(["ch1:done", "ch2a:running", "ch2b:pending"]);
    expect(saved(file).replan).toBeUndefined();
    expect(saved(file).state).toEqual({ split: true });
    h.host.answer(done());
    await flush();
    h.host.answer(done());
    expect((await h.dispatcher.result).reason).toBe("done");
  });

  it("calls the planner when the task fails, and when the reply is not readable", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    h.host.answer({ outcome: "failed", summary: "Source missing.", proposal: "" });
    await flush();
    expect(h.host.lastOpen().request.role).toBe("planner");
    expect(h.host.lastOpen().request.prompt).toContain("Task ch1 (Translate ch1) failed");
    h.host.answer({});
    await flush();
    h.host.answerText("I translated it, honestly.");
    await flush();
    const order = saved(file);
    expect(order.tasks[1]?.status).toBe("failed");
    expect(order.tasks[1]?.report?.summary).toBe(
      "the reply is not readable: I translated it, honestly.",
    );
    expect(h.host.lastOpen().request.role).toBe("planner");
  });

  it("reads a reply given as fenced JSON text", async () => {
    const file = tempOrder(orderText(task("ch1")));
    const h = await started(file);
    h.host.answerText('```json\n{"outcome":"done","summary":"Done.","proposal":""}\n```');
    expect((await h.dispatcher.result).reason).toBe("done");
  });

  it("keeps the backlog and the owed replan when the planner repeats an id that ran, and stops after two tries", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    h.host.answer(done("Translated.", { proposal: "redo ch1" }));
    await flush();
    h.host.answer({
      remove: ["ch2"],
      upsert: [backlogTask("ch1")],
      order: ["ch1"],
    });
    await flush();
    expect(h.host.lastOpen().request.role).toBe("planner");
    h.host.answer({
      remove: ["ch2"],
      upsert: [backlogTask("ch1")],
      order: ["ch1"],
    });
    const result = await h.dispatcher.result;
    expect(result.reason).toBe("replan-failed");
    expect(result.detail).toMatch(/is not pending/);
    expect(statuses(file)).toEqual(["ch1:done", "ch2:pending"]);
    expect(saved(file).replan).toHaveLength(1);
    expect(h.notifier.notices.map((notice) => notice.kind)).toEqual(["error"]);
  });

  it("refuses a backlog with a model plugin it does not have", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    h.host.answer(done("Translated.", { proposal: "use another plugin" }));
    await flush();
    const bad = { ...backlogTask("ch2"), model: { plugin: "nowhere", name: "x" } };
    h.host.answer({ upsert: [bad] });
    await flush();
    h.host.answer({ upsert: [bad] });
    const result = await h.dispatcher.result;
    expect(result.detail).toMatch(/no model plugin nowhere/);
    expect(statuses(file)).toEqual(["ch1:done", "ch2:pending"]);
  });

  it("rejects a patch that leaves a task waiting on a failed one, then runs the continuation", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2", "    after: [ch1]\n")}`));
    const h = await started(file);
    h.host.answer({ outcome: "failed", summary: "No.", proposal: "finish the rest" });
    await flush();
    expect(h.host.lastOpen().request.prompt).toContain("never becomes done");
    h.host.answer({});
    await flush();
    expect(h.host.lastOpen().request.role).toBe("planner");
    expect(statuses(file)).toEqual(["ch1:failed", "ch2:pending"]);
    h.host.answer({
      upsert: [backlogTask("ch1b"), backlogTask("ch2", ["ch1b"])],
      order: ["ch1b", "ch2"],
    });
    await flush();
    expect(statuses(file)).toEqual(["ch1:failed", "ch1b:running", "ch2:pending"]);
    h.host.answer(done());
    await flush();
    h.host.answer(done());
    expect((await h.dispatcher.result).reason).toBe("done");
  });

  it("stops as replan-failed when the planner twice leaves a task waiting on a failed one", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2", "    after: [ch1]\n")}`));
    const h = await started(file);
    h.host.answer({ outcome: "failed", summary: "No.", proposal: "" });
    await flush();
    h.host.answer({});
    await flush();
    h.host.answer({});
    const result = await h.dispatcher.result;
    expect(result.reason).toBe("replan-failed");
    expect(result.detail).toMatch(/will not be done/);
    expect(statuses(file)).toEqual(["ch1:failed", "ch2:pending"]);
  });

  it("replans a backlog that already waits on a task that will not be done", async () => {
    const file = tempOrder(
      orderText(`${task("ch1", "    status: failed\n")}${task("ch2", "    after: [ch1]\n")}`),
    );
    const h = await started(file);
    const planner = h.host.lastOpen();
    expect(planner.request.role).toBe("planner");
    expect(planner.request.prompt).toContain("ch1 is failed and will not be done");
    h.host.answer({ upsert: [backlogTask("ch2")] });
    await flush();
    expect(statuses(file)).toEqual(["ch1:failed", "ch2:running"]);
    h.host.answer(done());
    expect((await h.dispatcher.result).reason).toBe("done");
  });
});

describe("dispatcher: time", () => {
  it("reminds at 30, 45 and 50 minutes and closes the session at 55", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    const worker = h.host.lastOpen();
    expect(worker.request.prompt).toContain('Every 10 minutes it writes "minute N of 55"');
    await h.clock.advanceMinutes(10);
    expect(worker.sent).toEqual([
      {
        priority: "next",
        text: "Dispatcher clock: minute 10 of 55. Keep working. The dispatcher will tell you when to wrap up.",
      },
    ]);
    await h.clock.advanceMinutes(20);
    expect(worker.sent).toHaveLength(3);
    expect(worker.sent[1]?.text).toContain("minute 20 of 55");
    expect(worker.sent[2]?.priority).toBe("next");
    expect(worker.sent[2]?.text).toContain("30 minutes have passed");
    expect(worker.sent[2]?.text).toContain("minute 45");
    await h.clock.advanceMinutes(10);
    expect(worker.sent[3]?.text).toContain(
      "minute 40 of 55. Keep working. Plan to hand in by minute 45.",
    );
    await h.clock.advanceMinutes(5);
    expect(worker.sent[4]).toMatchObject({ priority: "now" });
    expect(worker.sent[4]?.text).toContain("45 minutes have passed");
    await h.clock.advanceMinutes(5);
    expect(worker.sent).toHaveLength(6);
    expect(worker.sent[5]?.text).toContain("50 minutes have passed");
    expect(worker.sent[5]?.text).toContain("closed at minute 55");
    await h.clock.advanceMinutes(5);
    expect(worker.closed).toBe(true);
    const order = saved(file);
    expect(order.tasks[0]?.status).toBe("interrupted");
    expect(order.tasks[0]?.report).toMatchObject({ reason: "time", minutes: 55 });
    expect(order.replan).toBeUndefined();
    expect(statuses(file)).toEqual(["ch1:interrupted", "ch1-cont:running", "ch2:pending"]);
    const next = h.host.lastOpen().request;
    expect(next.role).toBe("worker");
    expect(next.prompt).toContain("Your task: ch1-cont. Translate ch1");
    expect(next.prompt).toContain(
      "Translate ch1 of the fictional book.\n\nOrdo: a previous session (task ch1) did part of this task and was cut off when its time ran out at minute 55",
    );
  });

  it("calls the planner when a continuation runs out of time too", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2", "    after: [ch1]\n")}`));
    const h = await started(file);
    await h.clock.advanceMinutes(55);
    expect(saved(file).tasks[2]).toMatchObject({ id: "ch2", after: ["ch1-cont"] });
    await h.clock.advanceMinutes(55);
    expect(saved(file).replan).toEqual([{ reason: "interrupted", task: "ch1-cont", text: "" }]);
    const planner = h.host.lastOpen().request;
    expect(planner.role).toBe("planner");
    expect(planner.prompt).toContain("Task ch1-cont (Translate ch1) was interrupted at minute 55");
  });

  it("takes the minutes from the order settings, into the prompt and the reminders", async () => {
    const file = tempOrder(
      orderText(
        task("ch1"),
        "settings:\n  minutes: { remind: 10, wrap: 20, finish: 25, stop: 28 }\n",
      ),
    );
    const h = await started(file);
    const worker = h.host.lastOpen();
    expect(worker.request.prompt).toContain(
      "When the reminder says minute 10, estimate what is left",
    );
    expect(worker.request.prompt).toContain("minute 20");
    await h.clock.advanceMinutes(10);
    expect(worker.sent.map((item) => item.text)).toEqual([
      expect.stringContaining("10 minutes have passed"),
    ]);
    await h.clock.advanceMinutes(18);
    expect(saved(file).tasks[0]?.report?.summary).toContain("minute 28");
  });

  it("counts a planner that runs past its minutes as a failed replan", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    h.host.answer(done("Translated.", { proposal: "x" }));
    await flush();
    await h.clock.advanceMinutes(10);
    expect(h.log.lines.some((line) => line.message === "replan failed")).toBe(true);
    expect(h.host.lastOpen().request.role).toBe("planner");
  });
});

describe("dispatcher: usage limit", () => {
  it("interrupts the task, waits for the reset, then continues it without a replan", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    await h.clock.advanceMinutes(37);
    const resetsAt = new Date(h.clock.now() + 2 * 60 * 60_000);
    h.host.refuse(new SessionLimitError(resetsAt));
    await flush();
    let order = saved(file);
    expect(order.tasks[0]?.status).toBe("interrupted");
    expect(order.tasks[0]?.report).toMatchObject({ reason: "limit", minutes: 37 });
    expect(order.replan).toBeUndefined();
    expect(h.dispatcher.status().mode).toBe("waiting-limit");
    expect(h.notifier.notices.map((notice) => notice.kind)).toEqual(["limit"]);
    await h.clock.advanceMinutes(120);
    expect(h.host.open_()).toHaveLength(0);
    await h.clock.advanceMinutes(1);
    const worker = h.host.lastOpen();
    expect(worker.request.role).toBe("worker");
    expect(worker.request.prompt).toContain(
      "cut off by the usage limit of the account at minute 37",
    );
    order = saved(file);
    expect(order.tasks.map((item) => `${item.id}:${item.status}`)).toEqual([
      "ch1:interrupted",
      "ch1-cont:running",
      "ch2:pending",
    ]);
    // Cut again: the next continuation keeps the original prompt with one note.
    h.host.refuse(new SessionLimitError(new Date(h.clock.now() + 60_000)));
    await flush();
    await h.clock.advanceMinutes(3);
    const again = h.host.lastOpen().request.prompt;
    expect(again).toContain("Your task: ch1-cont-2");
    expect(again.match(/Ordo: a previous session/g)).toHaveLength(1);
    expect(again).toContain("(task ch1-cont)");
    expect(h.host.roles()).not.toContain("planner");
  });

  it("keeps the owed replan when the limit cuts the planner, and runs it after the wait", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    h.host.answer(done("Translated.", { proposal: "add ch3" }));
    await flush();
    h.host.refuse(new SessionLimitError(undefined));
    await flush();
    expect(saved(file).replan).toHaveLength(1);
    expect(h.dispatcher.status().mode).toBe("waiting-limit");
    await h.clock.advanceMinutes(30);
    expect(h.host.lastOpen().request.role).toBe("planner");
    expect(h.host.lastOpen().request.prompt).toContain("add ch3");
  });

  it("plans with Claude when the planner's plugin is limited with no reset time", async () => {
    const claude = new ScriptedHost();
    const file = tempOrder(
      orderText(`${task("ch1")}${task("ch2")}${task("ch3")}`)
        .replace(
          "planner: { plugin: test, name: big-model, effort: medium }",
          "planner: { plugin: test, name: big-model }",
        )
        .replaceAll(SMALL, "{ plugin: claude-code, name: claude-sonnet-5-5, effort: high }"),
    );
    const openai = new ScriptedHost();
    const h = await started(file, { hosts: { test: openai, "claude-code": claude } });
    claude.answer(done("Translated.", { proposal: "add ch3" }));
    await flush();
    openai.refuse(new SessionLimitError(undefined));
    await flush();
    const fallback = claude.lastOpen().request;
    expect(fallback.role).toBe("planner");
    expect(fallback.model).toBe("claude-sonnet-5-5");
    expect(fallback.effort).toBe("high");
    expect(fallback.prompt).toContain("You run as claude-sonnet-5-5 (high) via claude-code");
    expect(fallback.prompt).toContain("add ch3");
    expect(h.dispatcher.status().mode).toBe("replanning");
    claude.answer({});
    await flush();
    // The next replan within limitRetry goes to the fallback too, then back to the planner.
    claude.answer(done("Translated.", { proposal: "add ch4" }));
    await flush();
    expect(claude.lastOpen().request.role).toBe("planner");
    claude.answer({});
    await flush();
    await h.clock.advanceMinutes(31);
    claude.answer(done("Translated.", { proposal: "add ch5" }));
    await flush();
    expect(openai.lastOpen().request.role).toBe("planner");
    expect(h.notifier.notices).toEqual([]);
  });

  it("names its planner fallback, and waits when the reset is near", async () => {
    const other = new ScriptedHost();
    const file = tempOrder(
      orderText(
        `${task("ch1")}${task("ch2")}`,
        "plannerFallback: { plugin: other, name: spare }\n",
      ),
    );
    const host = new ScriptedHost();
    const h = await started(file, { hosts: { test: host, other } });
    host.answer(done("Translated.", { proposal: "add ch3" }));
    await flush();
    host.refuse(new SessionLimitError(new Date(h.clock.now() + 5 * 60_000)));
    await flush();
    expect(h.dispatcher.status().mode).toBe("waiting-limit");
    expect(other.sessions).toHaveLength(0);
    await h.clock.advanceMinutes(6);
    host.refuse(new SessionLimitError(new Date(h.clock.now() + 5 * 60 * 60_000)));
    await flush();
    expect(other.lastOpen().request.model).toBe("spare");
  });

  it("warns the owner once when the weekly window is nearly used up", async () => {
    const file = tempOrder(orderText(task("ch1")));
    const h = await started(file);
    const usage = h.host.lastOpen().request.onUsage;
    usage?.({ type: "five_hour", utilization: 0.99 });
    usage?.({ type: "seven_day", utilization: 0.91 });
    usage?.({ type: "seven_day", utilization: 0.95 });
    await flush();
    expect(h.notifier.notices.map((notice) => notice.kind)).toEqual(["usage"]);
    expect(h.notifier.notices[0]?.text).toContain("91 %");
  });
});

describe("dispatcher: questions", () => {
  it("blocks a task on questions, notifies the owner, and replans with the answers", async () => {
    const file = tempOrder(
      orderText(`${task("ch1")}${task("ch2", "    after: [ch1]\n")}${task("ch3")}`),
    );
    const h = await started(file);
    h.host.answer({
      outcome: "blocked",
      summary: "Two names have two spellings.",
      proposal: "",
      questions: ["Use Colour or Color?"],
    });
    await flush();
    expect(saved(file).questions?.map((q) => q.id)).toEqual(["q1"]);
    expect(h.notifier.notices[0]?.kind).toBe("questions");
    expect(h.notifier.notices[0]?.text).toContain("q1 [ch1]: Use Colour or Color?");
    // ch3 does not depend on ch1 and goes on.
    expect(h.host.lastOpen().request.prompt).toContain("Your task: ch3");
    h.host.answer(done());
    await flush();
    expect(h.dispatcher.status().mode).toBe("waiting-owner");
    h.dispatcher.answer("q1", "Colour");
    await flush();
    const planner = h.host.lastOpen();
    expect(planner.request.role).toBe("planner");
    expect(planner.request.prompt).toContain("Answer (owner): Colour");
    h.host.answer({
      upsert: [backlogTask("ch1b"), backlogTask("ch2", ["ch1b"])],
      order: ["ch1b", "ch2"],
    });
    await flush();
    h.host.answer(done());
    await flush();
    h.host.answer(done());
    expect((await h.dispatcher.result).reason).toBe("done");
    expect(statuses(file)).toEqual(["ch1:blocked", "ch3:done", "ch1b:done", "ch2:done"]);
  });

  it("lets the decider answer first and tells the owner only what it left", async () => {
    const file = tempOrder(orderText(task("ch1"), `decider: ${BIG}\n`));
    const h = await started(file);
    h.host.answer({
      outcome: "blocked",
      summary: "Questions.",
      proposal: "",
      questions: ["Which spelling?", "Publish now?"],
    });
    await flush();
    const decider = h.host.lastOpen();
    expect(decider.request.role).toBe("decider");
    expect(h.notifier.notices).toHaveLength(0);
    h.host.answer({
      answers: [
        { id: "q1", answer: "British" },
        { id: "q2", answer: "" },
      ],
    });
    await flush();
    const order = saved(file);
    expect(order.questions?.[0]).toMatchObject({
      answer: "British",
      answeredBy: "decider big-model (medium) via test",
    });
    expect(order.questions?.[1]?.answer).toBeUndefined();
    expect(h.notifier.notices.map((notice) => notice.text)).toEqual([
      expect.stringContaining("q2 [ch1]: Publish now?"),
    ]);
  });

  it("treats blocked without questions as failed", async () => {
    const file = tempOrder(orderText(task("ch1")));
    const h = await started(file);
    h.host.answer({ outcome: "blocked", summary: "Stuck.", proposal: "" });
    await flush();
    expect(saved(file).tasks[0]?.status).toBe("failed");
    expect(h.host.lastOpen().request.role).toBe("planner");
  });
});

describe("dispatcher: pause, resume, stop", () => {
  it("asks running workers to hand in, finishes the replan, then waits for resume", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    const worker = h.host.lastOpen();
    h.dispatcher.pause(false);
    expect(worker.sent).toEqual([{ text: PAUSE_TEXT, priority: "now" }]);
    expect(h.dispatcher.status().mode).toBe("pausing");
    h.host.answer({
      outcome: "failed",
      summary: "Half done.",
      proposal: "Finish ch1 from page 9.",
    });
    await flush();
    expect(h.host.lastOpen().request.role).toBe("planner");
    h.host.answer({
      upsert: [backlogTask("ch1-rest")],
      order: ["ch1-rest", "ch2"],
    });
    await flush();
    expect(h.dispatcher.status().mode).toBe("paused");
    expect(h.host.open_()).toHaveLength(0);
    h.dispatcher.resume();
    await flush();
    expect(h.host.lastOpen().request.prompt).toContain("Your task: ch1-rest");
  });

  it("lets workers finish on their own with drain", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    const worker = h.host.lastOpen();
    h.dispatcher.pause(true);
    expect(worker.sent).toEqual([]);
    h.host.answer(done());
    await flush();
    expect(h.dispatcher.status().mode).toBe("paused");
    expect(statuses(file)).toEqual(["ch1:done", "ch2:pending"]);
  });

  it("stops at once: the running task is interrupted and the next start continues it", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    await h.clock.advanceMinutes(12);
    h.dispatcher.stop();
    expect(await h.dispatcher.result).toEqual({ reason: "stopped" });
    expect(h.host.last().closed).toBe(true);
    const order = saved(file);
    expect(order.tasks[0]?.report).toMatchObject({ reason: "stop", minutes: 12 });
    expect(order.replan).toBeUndefined();
    expect(h.notifier.notices).toHaveLength(0);
    const again = await started(file);
    expect(again.host.lastOpen().request.role).toBe("worker");
    expect(again.host.lastOpen().request.prompt).toContain(
      "cut off when the owner stopped the dispatcher at minute 12",
    );
  });
});

describe("dispatcher: one file, one process", () => {
  it("interrupts a task left running by a dead process and continues it", async () => {
    const file = tempOrder(orderText(`${task("ch1", "    status: running\n")}${task("ch2")}`));
    const h = await started(file);
    expect(statuses(file)).toEqual(["ch1:interrupted", "ch1-cont:running", "ch2:pending"]);
    expect(h.host.lastOpen().request.prompt).toContain("cut off when the dispatcher stopped");
  });

  it("refuses a second dispatcher while the first holds the lock", async () => {
    const file = tempOrder(orderText(task("ch1")));
    await started(file);
    expect(() => {
      harness(file).dispatcher.start();
    }).toThrow(/already run by process/);
  });

  it("takes over a lock whose process is gone", async () => {
    const file = tempOrder(orderText(task("ch1")));
    const paths = orderPaths(file);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.lock, "999999999\n");
    const h = await started(file);
    expect(h.host.sessions).toHaveLength(1);
  });

  it("splits a one-file order into the order, the live file and the archive", async () => {
    const file = tempOrder(
      `# The owner's comment stays.\n${orderText(`${task("ch0", "    status: done\n")}${task("ch1")}${task("ch2")}`)}`,
    );
    const h = await started(file);
    const paths = orderPaths(file);
    const head = readFileSync(file, "utf8");
    expect(head).toContain("# The owner's comment stays.");
    expect(head).toContain("title: Fictional book");
    expect(head).not.toMatch(/^(state|tasks):/m);
    expect(readFileSync(paths.live, "utf8")).not.toContain("ch0");
    expect(readFileSync(join(paths.archive, "ch0.yaml"), "utf8")).toContain("seq: 1");
    h.host.answer(done());
    await flush();
    expect(readFileSync(join(paths.archive, "ch1.yaml"), "utf8")).toContain("seq: 2");
    expect(statuses(file)).toEqual(["ch0:done", "ch1:done", "ch2:running"]);
    h.dispatcher.stop();
    await h.dispatcher.result;
    expect(statuses(file)).toEqual(["ch0:done", "ch1:done", "ch2:interrupted", "ch2-cont:pending"]);
    expect(existsSync(join(paths.archive, "ch2.yaml"))).toBe(true);
  });

  it("takes in an order file the owner edits while it runs", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    const edited = readFileSync(file, "utf8")
      .replace("Fictional book", "Edited by hand")
      .replace("chapter by chapter", "page by page");
    writeFileSync(file, edited);
    h.host.answer(done());
    await flush();
    expect(h.host.lastOpen().request.prompt).toContain("page by page");
    expect(h.dispatcher.status().title).toBe("Edited by hand");
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(h.log.lines.some((line) => line.message.startsWith("the order file changed"))).toBe(
      true,
    );
  });

  it("keeps its version of the order when the owner's edit is not valid", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    writeFileSync(file, readFileSync(file, "utf8").replace("title:", "titel:"));
    h.host.answer(done());
    await flush();
    expect(h.host.lastOpen().request.prompt).toContain("Your task: ch2");
    expect(h.dispatcher.status().title).toBe("Fictional book");
    expect(h.notifier.notices.map((notice) => notice.kind)).toEqual(["error"]);
  });

  it("stops without overwriting a live file someone else changed", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    const h = await started(file);
    const live = orderPaths(file).live;
    const edited = readFileSync(live, "utf8").replace("Translate ch2", "Edited by hand");
    writeFileSync(live, edited);
    h.host.answer(done());
    const result = await h.dispatcher.result;
    expect(result.reason).toBe("conflict");
    expect(readFileSync(live, "utf8")).toBe(edited);
    expect(existsSync(join(orderPaths(file).runDir, "order.conflict.yaml"))).toBe(true);
  });

  it("refuses an order whose model plugin it does not have", () => {
    const file = tempOrder(orderText(task("ch1")).replace(SMALL, "{ plugin: api, name: x }"));
    expect(() => {
      harness(file).dispatcher.start();
    }).toThrow(/no model plugin api/);
    expect(existsSync(orderPaths(file).lock)).toBe(false);
  });
});

describe("dispatcher: pool", () => {
  it("runs up to the pool size at once and keeps after", async () => {
    const file = tempOrder(
      orderText(
        `${task("a")}${task("b")}${task("c", "    after: [a]\n")}${task("d")}`,
        "settings:\n  pool: 2\n",
      ),
    );
    const h = await started(file);
    expect(statuses(file)).toEqual(["a:running", "b:running", "c:pending", "d:pending"]);
    expect(h.host.sessions[1]?.request.prompt).toContain("Up to 2 workers run at the same time");
    expect(h.host.sessions[1]?.request.prompt).toContain("Running now: a (Translate a)");
    h.host.answer(done(), h.host.sessions[1]);
    await flush();
    // Tasks that ran come first: they are read from the archive.
    expect(statuses(file)).toEqual(["b:done", "a:running", "c:pending", "d:running"]);
    h.host.answer(done(), h.host.sessions[0]);
    await flush();
    expect(statuses(file)).toEqual(["b:done", "a:done", "c:running", "d:running"]);
  });

  it("merges state patches of parallel workers", async () => {
    const file = tempOrder(orderText(`${task("a")}${task("b")}`, "settings:\n  pool: 2\n"));
    const h = await started(file, { pool: 2 });
    h.host.answer(done("a", { statePatch: { a: 1 } }), h.host.sessions[0]);
    h.host.answer(done("b", { statePatch: { b: 2 } }), h.host.sessions[1]);
    await h.dispatcher.result;
    expect(saved(file).state).toEqual({ a: 1, b: 2 });
  });

  it("starts no task while the planner works, and applies its state as a change", async () => {
    const file = tempOrder(
      orderText(`${task("a")}${task("b")}${task("c")}`, "settings:\n  pool: 2\n"),
    );
    const h = await started(file);
    h.host.answer(
      done("a", { statePatch: { seen: ["a"] }, proposal: "rename c" }),
      h.host.sessions[0],
    );
    await flush();
    expect(h.host.lastOpen().request.role).toBe("planner");
    expect(statuses(file)).toEqual(["a:done", "b:running", "c:pending"]);
    // b finishes while the planner works.
    h.host.answer(done("b", { statePatch: { b: true } }), h.host.sessions[1]);
    await flush();
    expect(h.host.open_().map((session) => session.request.role)).toEqual(["planner"]);
    h.host.answer({
      statePatch: { planned: true },
      remove: ["c"],
      upsert: [backlogTask("c2")],
      order: ["c2"],
    });
    await flush();
    const order = saved(file);
    expect(order.state).toEqual({ seen: ["a"], b: true, planned: true });
    expect(statuses(file)).toEqual(["a:done", "b:done", "c2:running"]);
  });
});

describe("dispatcher: status", () => {
  it("reports mode, counts, running tasks and totals", async () => {
    const file = tempOrder(
      orderText(
        `${task("ch1", "    status: done\n    report: { summary: s, proposal: '', minutes: 20, costUsd: 0.5 }\n")}${task("ch2")}${task("ch3")}`,
      ),
    );
    const h = await started(file);
    await h.clock.advanceMinutes(7);
    const status = h.dispatcher.status();
    expect(status.mode).toBe("running");
    expect(status.counts).toMatchObject({ done: 1, running: 1, pending: 1 });
    expect(status.running).toEqual([{ id: "ch2", title: "Translate ch2", minutes: 7 }]);
    expect(status.totals).toEqual({ minutes: 20, costUsd: 0.5, sessions: 1 });
    h.dispatcher.pause(true);
    await h.clock.advanceMinutes(3);
    const pausing = h.dispatcher.status();
    expect(pausing.mode).toBe("pausing");
    expect(Date.parse(pausing.since ?? "")).toBe(h.clock.now() - 3 * 60_000);
  });

  it("answers control requests", async () => {
    const file = tempOrder(orderText(task("ch1")));
    const h = await started(file);
    expect(h.dispatcher.handle({ cmd: "answer", id: "q1", text: "x" })).toEqual({
      ok: false,
      error: "no question q1",
    });
    const reply = h.dispatcher.handle({ cmd: "pause", drain: true });
    expect(reply.ok && reply.status.mode).toBe("pausing");
  });
});

describe("dispatcher: disk space", () => {
  it("starts no session while free space is short, tells the owner, and goes on when it is back", async () => {
    const file = tempOrder(
      orderText(`${task("ch1")}${task("ch2")}`, "settings:\n  minFreeMB: 500\n"),
    );
    let free = 2000 * 1024 * 1024;
    const h = await started(file, { freeBytes: () => free });
    expect(h.host.sessions).toHaveLength(1);
    free = 300 * 1024 * 1024;
    h.host.answer(done());
    await flush();
    expect(h.host.open_()).toHaveLength(0);
    expect(statuses(file)).toEqual(["ch1:done", "ch2:pending"]);
    expect(h.dispatcher.status().mode).toBe("waiting-disk");
    expect(h.notifier.notices.map((notice) => notice.text)).toEqual([
      expect.stringContaining("Only 300 MB are free"),
    ]);
    await h.clock.advanceMinutes(5);
    expect(h.host.open_()).toHaveLength(0);
    expect(h.notifier.notices).toHaveLength(1);
    free = 600 * 1024 * 1024;
    await h.clock.advanceMinutes(5);
    expect(h.host.lastOpen().request.prompt).toContain("Your task: ch2");
    expect(h.dispatcher.status().mode).toBe("running");
    expect(h.notifier.notices[1]?.text).toContain("600 MB are free again");
  });

  it("checks before a replan too, and not at all with minFreeMB 0", async () => {
    const file = tempOrder(orderText(`${task("ch1")}${task("ch2")}`));
    let free = 2 * 1024 * 1024 * 1024;
    const h = await started(file, { freeBytes: () => free });
    free = 0;
    h.host.answer(done("Translated.", { proposal: "add ch3" }));
    await flush();
    expect(h.host.open_()).toHaveLength(0);
    expect(h.dispatcher.status().mode).toBe("waiting-disk");
    const off = tempOrder(orderText(task("ch1"), "settings:\n  minFreeMB: 0\n"));
    const unchecked = await started(off, { freeBytes: () => 0 });
    expect(unchecked.host.sessions).toHaveLength(1);
  });
});

describe("dispatcher: sessions", () => {
  it("passes the disallowed tools and writes a transcript per session", async () => {
    const file = tempOrder(orderText(task("ch1"), "settings:\n  disallowedTools: [WebSearch]\n"));
    const h = await started(file);
    const request = h.host.lastOpen().request;
    expect(request.disallowedTools).toEqual(["WebSearch"]);
    request.transcript("assistant text: key sk-ant-abc123 here");
    const transcript = join(orderPaths(file).sessions, "0001-worker-ch1.log");
    const text = readFileSync(transcript, "utf8");
    expect(text).toContain("prompt | You are a worker of Ordo");
    expect(text).toContain("key sk-… here");
    expect(text).not.toContain("abc123");
  });
});

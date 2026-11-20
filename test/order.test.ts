import { afterEach, describe, expect, it } from "vitest";
import { limitWatch } from "../src/limit.ts";
import {
  DEFAULT_MINUTES,
  type Order,
  answerQuestion,
  applyPlan,
  formatOrder,
  mergePatch,
  minutesOf,
  orderWarnings,
  parseOrder,
  recoverOrder,
  runnableTasks,
  stateDiff,
  tickMinutes,
} from "../src/order.ts";
import { SessionLimitError } from "../src/session.ts";
import { SMALL, cleanTemp, orderText, task } from "./helpers.ts";

afterEach(cleanTemp);

const NOW = new Date("2030-01-01T00:00:00Z");

describe("parseOrder", () => {
  it("reads a task without an explicit status as pending and round-trips", () => {
    const order = parseOrder(orderText(task("ch1")));
    expect(order.tasks[0]?.status).toBe("pending");
    expect(order.tasks[0]?.model).toEqual({ plugin: "test", name: "small-model" });
    expect(parseOrder(formatOrder(order))).toEqual(order);
  });

  it("rejects a repeated task id", () => {
    expect(() => parseOrder(orderText(`${task("ch1")}${task("ch1")}`))).toThrow(/duplicate id ch1/);
  });

  it("names every problem with the path to the field", () => {
    const text = orderText(`  - id: ch1
    title: ""
    model: { plugin: test }
    prompt: x
    colour: red
`);
    expect(() => parseOrder(text)).toThrow(/tasks\.0\.title/);
    expect(() => parseOrder(text)).toThrow(/tasks\.0\.model\.name/);
    expect(() => parseOrder(text)).toThrow(/colour/);
  });

  it("keeps a multiline prompt, a numeric state and a report", () => {
    const order = parseOrder(
      orderText(`  - id: ch1
    title: Chapter
    model: ${SMALL}
    prompt: |
      First line.
      Second line.
    status: done
    report:
      summary: translated
      proposal: ""
      minutes: 12.5
`).replace("state: {}", "state:\n  chapter: 3\n"),
    );
    expect(order.state).toEqual({ chapter: 3 });
    expect(order.tasks[0]?.prompt).toBe("First line.\nSecond line.\n");
    expect(order.tasks[0]?.report).toEqual({ summary: "translated", proposal: "", minutes: 12.5 });
  });

  it("keeps an owed replan and the questions", () => {
    const order = parseOrder(
      orderText(task("ch1", "    status: blocked\n")).replace(
        "state: {}",
        `state: {}
replan:
  - { reason: proposal, task: ch1, text: add a glossary task }
questions:
  - { id: q1, task: ch1, text: Which spelling?, askedAt: "2030-01-01T00:00:00.000Z" }`,
      ),
    );
    expect(order.replan).toEqual([
      { reason: "proposal", task: "ch1", text: "add a glossary task" },
    ]);
    expect(order.questions?.[0]?.id).toBe("q1");
    expect(parseOrder(formatOrder(order))).toEqual(order);
  });

  it("rejects an after that points nowhere and a cycle", () => {
    expect(() => parseOrder(orderText(task("ch1", "    after: [ch0]\n")))).toThrow(/no task ch0/);
    expect(() =>
      parseOrder(orderText(`${task("a", "    after: [b]\n")}${task("b", "    after: [a]\n")}`)),
    ).toThrow(/cycle/);
  });

  it("checks that the minutes grow and fills the defaults", () => {
    expect(() =>
      parseOrder(orderText(task("ch1"), "settings:\n  minutes: { remind: 50, wrap: 45 }\n")),
    ).toThrow(/remind < wrap < finish < stop/);
    const order = parseOrder(orderText(task("ch1"), "settings:\n  minutes: { stop: 58 }\n"));
    expect(minutesOf(order.settings)).toEqual({
      tick: 10,
      remind: 30,
      wrap: 45,
      finish: 50,
      stop: 58,
      replan: 10,
      limitRetry: 30,
    });
  });
});

describe("time", () => {
  it("tells the minute every tick until wrap, except at the reminder", () => {
    expect(tickMinutes(DEFAULT_MINUTES)).toEqual([10, 20, 40]);
    expect(tickMinutes({ ...DEFAULT_MINUTES, tick: 15 })).toEqual([15]);
    expect(tickMinutes({ ...DEFAULT_MINUTES, tick: 60 })).toEqual([]);
  });

  it("warns about time limits in the context and the open tasks, and a large state", () => {
    const order = parseOrder(
      orderText(
        `${task("a", "    status: done\n")}${task("b")}${task("c")}${task("d")}${task("e")}`,
      ),
    );
    const prompts: Record<string, string> = {
      a: "Stop after 40 minutes.",
      b: "Не більше 45 хвилин, після 40-ї хвилини нового скана не починай.",
      c: "Hand in at minute 40.",
      d: "Read 12 pages; a 3-page letter counts as one.",
      e: "Wrap up within a 30-minute session.",
    };
    const warned = orderWarnings({
      ...order,
      context: "Each document takes about 5 хв to read.",
      state: { big: "x".repeat(11 * 1024) },
      tasks: order.tasks.map((item) => ({ ...item, prompt: prompts[item.id] ?? "" })),
    });
    expect(warned).toEqual([
      expect.stringMatching(/^context: "5 хв" looks like a time limit/),
      expect.stringMatching(/^tasks\.b\.prompt: "45 хвилин"/),
      expect.stringMatching(/^tasks\.c\.prompt: "minute 40"/),
      expect.stringMatching(/^tasks\.e\.prompt: "30-minute"/),
      expect.stringMatching(/^state: 11 KB goes into every prompt/),
    ]);
    expect(orderWarnings(parseOrder(orderText(task("a"))))).toEqual([]);
  });
});

describe("runnableTasks", () => {
  it("holds a task until every task in its after is done", () => {
    const order = parseOrder(
      orderText(
        `${task("a", "    status: done\n")}${task("b")}${task("c", "    after: [a, b]\n")}${task("d", "    after: [a]\n")}`,
      ),
    );
    expect(runnableTasks(order).map((item) => item.id)).toEqual(["b", "d"]);
  });
});

describe("limitWatch", () => {
  const reset = new Date("2026-01-05T10:00:00Z");

  it("reports the limit when the model call is refused for it", () => {
    const see = limitWatch();
    expect(see({ type: "rejected", resetsAt: reset })).toBeNull();
    const error = see({ type: "refused" });
    expect(error).toBeInstanceOf(SessionLimitError);
    expect(error?.resetsAt).toEqual(reset);
  });

  it("reports the limit when a turn ends in an error after a rejected limit", () => {
    const see = limitWatch();
    expect(see({ type: "error-result" })).toBeNull();
    expect(see({ type: "rejected", resetsAt: undefined })).toBeNull();
    expect(see({ type: "error-result" })).toBeInstanceOf(SessionLimitError);
  });

  it("forgets a rejected limit once the account is allowed again", () => {
    const see = limitWatch();
    see({ type: "rejected", resetsAt: reset });
    see({ type: "allowed" });
    expect(see({ type: "error-result" })).toBeNull();
    expect(see({ type: "refused" })?.resetsAt).toBeUndefined();
  });
});

describe("state patches", () => {
  it("merges objects, replaces other values and removes keys set to null", () => {
    expect(
      mergePatch(
        { a: 1, b: { c: 1, d: 2 }, e: [1] },
        { a: 2, b: { c: null, f: 3 }, e: [2], g: null },
      ),
    ).toEqual({ a: 2, b: { d: 2, f: 3 }, e: [2] });
  });

  it("describes a change of the top-level keys as a patch", () => {
    expect(stateDiff({ a: 1, b: 2, c: { x: 1 } }, { a: 1, c: { x: 2 }, d: 4 })).toEqual({
      b: null,
      c: { x: 2 },
      d: 4,
    });
  });
});

describe("applyPlan", () => {
  function base(): Order {
    return parseOrder(
      orderText(
        `${task("done-one", '    status: done\n    report: { summary: ok, proposal: "drop ch3" }\n')}${task("ch2", "    status: failed\n")}${task("ch3")}`,
      ).replace(
        "state: {}",
        "state: {}\nreplan:\n  - { reason: proposal, task: done-one, text: drop ch3 }\n  - { reason: failed, task: ch2, text: '' }",
      ),
    );
  }

  const draft = { title: "x", model: { plugin: "test", name: "m" }, prompt: "x" };

  it("replaces pending tasks and settles the replan item it was shown", () => {
    const next = applyPlan(
      base(),
      {
        statePatch: { chapter: 2 },
        remove: ["ch3"],
        upsert: [
          {
            id: "ch2b",
            title: "Second chapter, again",
            model: { plugin: "test", name: "small-model" },
            prompt: "Again.",
            after: ["done-one"],
          },
        ],
        order: ["ch2b"],
      },
      1,
    );
    expect(next.tasks.map((item) => `${item.id}:${item.status}`)).toEqual([
      "done-one:done",
      "ch2:failed",
      "ch2b:pending",
    ]);
    expect(next.state).toEqual({ chapter: 2 });
    expect(next.replan).toEqual([{ reason: "failed", task: "ch2", text: "" }]);
  });

  it("rejects an upsert id that is not pending", () => {
    expect(() => applyPlan(base(), { upsert: [{ id: "done-one", ...draft }] }, 2)).toThrow(
      /is not pending/,
    );
  });

  it("rejects a pending task that waits on a task that will not be done", () => {
    expect(() =>
      applyPlan(base(), { upsert: [{ id: "ch3", after: ["ch2"], ...draft }] }, 2),
    ).toThrow(/ch2 is failed and will not be done/);
  });

  it("rejects an after that names a missing task", () => {
    expect(() =>
      applyPlan(
        base(),
        { upsert: [{ id: "n", after: ["gone"], ...draft }], order: ["ch3", "n"] },
        2,
      ),
    ).toThrow(/no task gone/);
  });

  it("rejects an add or a remove that omits order", () => {
    expect(() => applyPlan(base(), { upsert: [{ id: "n", ...draft }] }, 2)).toThrow(
      /order is required/,
    );
    expect(() => applyPlan(base(), { remove: ["ch3"] }, 2)).toThrow(/order is required/);
  });

  it("keeps position when an in-place upsert omits order", () => {
    const order = parseOrder(orderText(`${task("ch2")}${task("ch3")}${task("ch4")}`));
    const next = applyPlan(
      order,
      {
        upsert: [
          {
            id: "ch3",
            title: "Middle, revised",
            model: { plugin: "test", name: "small-model" },
            prompt: "Revised.",
          },
        ],
      },
      0,
    );
    expect(next.tasks.map((item) => `${item.id}:${item.title}`)).toEqual([
      "ch2:Translate ch2",
      "ch3:Middle, revised",
      "ch4:Translate ch4",
    ]);
    expect(next.tasks.every((item) => item.status === "pending")).toBe(true);
  });
});

describe("answerQuestion", () => {
  const blocked = (): Order =>
    parseOrder(
      orderText(task("ch1", "    status: blocked\n")).replace(
        "state: {}",
        `state: {}
questions:
  - { id: q1, task: ch1, text: Which spelling?, askedAt: "2030-01-01T00:00:00.000Z" }
  - { id: q2, task: ch1, text: Keep the footnotes?, askedAt: "2030-01-01T00:00:00.000Z" }`,
      ),
    );

  it("owes a replan with every answer once the last question of a blocked task is answered", () => {
    const one = answerQuestion(blocked(), "q1", "Colour", "owner", NOW);
    expect(one.replan).toBeUndefined();
    const both = answerQuestion(one, "q2", "Yes", "owner", NOW);
    expect(both.replan).toHaveLength(1);
    expect(both.replan?.[0]?.reason).toBe("answers");
    expect(both.replan?.[0]?.text).toContain("Which spelling?");
    expect(both.replan?.[0]?.text).toContain("Yes");
  });

  it("refuses an unknown or an answered question", () => {
    expect(() => answerQuestion(blocked(), "q9", "x", "owner", NOW)).toThrow(/no question q9/);
    const one = answerQuestion(blocked(), "q1", "x", "owner", NOW);
    expect(() => answerQuestion(one, "q1", "y", "owner", NOW)).toThrow(/already answered/);
  });
});

describe("recoverOrder", () => {
  it("interrupts tasks left running and continues them", () => {
    const order = recoverOrder(
      parseOrder(orderText(`${task("ch1", "    status: running\n")}${task("ch2")}`)),
    );
    expect(order?.tasks[0]?.status).toBe("interrupted");
    expect(order?.tasks[0]?.report?.reason).toBe("crash");
    expect(order?.tasks.map((item) => `${item.id}:${item.status}`)).toEqual([
      "ch1:interrupted",
      "ch1-cont:pending",
      "ch2:pending",
    ]);
    expect(order?.replan).toBeUndefined();
    expect(recoverOrder(parseOrder(orderText(task("ch1"))))).toBeNull();
  });
});

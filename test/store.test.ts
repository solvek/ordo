import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { orderPaths } from "../src/files.ts";
import { formatArchived, parseOrder } from "../src/order.ts";
import { readStored, splitOrder, writeStored } from "../src/store.ts";
import { cleanTemp, orderText, task, tempOrder } from "./helpers.ts";

afterEach(cleanTemp);

const ran = (id: string): string =>
  task(id, "    status: done\n    report: { summary: Done., proposal: '' }\n");

describe("order files", () => {
  it("reads a one-file order and splits it, keeping the order of the tasks", () => {
    const file = tempOrder(orderText(`${ran("a")}${ran("b")}${task("c")}`));
    const paths = orderPaths(file);
    const single = readStored(paths);
    expect(single.layout).toBe("single");
    const split = splitOrder(paths, single);
    expect(split.layout).toBe("split");
    const again = readStored(paths);
    expect(again.order).toEqual(single.order);
    expect([...again.archived.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(readFileSync(paths.live, "utf8")).toMatch(/^state: \{\}\ntasks:\n {2}- id: c\n/);
  });

  it("refuses an order whose live part is in both places, or in none", () => {
    const file = tempOrder(orderText(task("a")));
    const paths = orderPaths(file);
    const text = readFileSync(file, "utf8");
    splitOrder(paths, readStored(paths));
    const head = readFileSync(file, "utf8");
    writeFileSync(file, text);
    expect(() => readStored(paths)).toThrow(/exists too/);
    writeFileSync(file, head);
    writeFileSync(paths.live, "state: {}\ntasks: []\nextra: 1\n");
    expect(() => readStored(paths)).toThrow(/live\.yaml:\norder: Unrecognized key: "extra"/);
    writeFileSync(paths.live, "state: {}\ntasks: []\n");
    expect(readStored(paths).order.tasks).toEqual([]);
  });

  it("lets the archive win over the live file after a crash between the two writes", () => {
    const file = tempOrder(orderText(`${task("a")}${task("b")}`));
    const paths = orderPaths(file);
    const stored = splitOrder(paths, readStored(paths));
    const [first] = stored.order.tasks;
    if (first === undefined) throw new Error("no task");
    mkdirSync(paths.archive);
    writeFileSync(
      join(paths.archive, "a.yaml"),
      formatArchived({ ...first, status: "done", report: { summary: "s", proposal: "" } }, 1),
    );
    expect(readStored(paths).order.tasks.map((item) => `${item.id}:${item.status}`)).toEqual([
      "a:done",
      "b:pending",
    ]);
  });

  it("writes each task that ran to the archive once", () => {
    const file = tempOrder(orderText(`${task("a")}${task("b")}`));
    const paths = orderPaths(file);
    const stored = splitOrder(paths, readStored(paths));
    const order = parseOrder(orderText(`${ran("a")}${task("b")}`));
    writeStored(paths, order, stored.archived);
    const archived = join(paths.archive, "a.yaml");
    expect(existsSync(archived)).toBe(true);
    expect(stored.archived.get("a")).toBe(1);
    writeFileSync(archived, `${readFileSync(archived, "utf8")}# kept\n`);
    writeStored(paths, order, stored.archived);
    expect(readFileSync(archived, "utf8")).toContain("# kept");
  });

  it("refuses an archive file that holds another task", () => {
    const file = tempOrder(orderText(`${ran("a")}${task("b")}`));
    const paths = orderPaths(file);
    splitOrder(paths, readStored(paths));
    writeFileSync(join(paths.archive, "x.yaml"), readFileSync(join(paths.archive, "a.yaml")));
    expect(() => readStored(paths)).toThrow(/x\.yaml: holds task a/);
  });

  it("refuses a task id that cannot name a file", () => {
    expect(() => parseOrder(orderText(task("a/b")))).toThrow(/tasks\.0\.id: use letters/);
    expect(parseOrder(orderText(task("розділ-1.2_a"))).tasks[0]?.id).toBe("розділ-1.2_a");
  });
});

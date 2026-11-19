#!/usr/bin/env node
// ordo: run and control dispatchers. The commands only parse arguments, read files and print;
// the work is in the library.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudeHost } from "./claude.ts";
import { openaiEnvProblems, openaiHost } from "./openai.ts";
import { registrations, register, sendControl, serveControl, statusFromReply } from "./control.ts";
import { Dispatcher, type RunResult } from "./dispatcher.ts";
import { acquireLock, lockHolder, orderPaths, readOrderText, writeAtomic } from "./files.ts";
import { createLogger, parseLevel, prettyLine } from "./logger.ts";
import { createNotifiers, telegramChats } from "./notify.ts";
import {
  OrderError,
  answerQuestion,
  formatOrder,
  orderPlugins,
  parseOrder,
  textHash,
} from "./order.ts";
import { type SessionHost } from "./session.ts";
import { type StatusReport, fileStatus, formatStatus } from "./status.ts";

const HELP = `ordo — run a long piece of work as short model sessions

Usage:
  ordo start <order.yaml> [--pool N] [--use-api-key]   run in the background
  ordo run <order.yaml> [--pool N] [--use-api-key] [-v] run in the foreground
  ordo status [<order.yaml>] [--json]                   status of one order or of all running
  ordo list                                             running dispatchers
  ordo pause [<order.yaml>] [--drain]                  ask workers to hand in, start nothing new
  ordo resume [<order.yaml>]                            go on after a pause
  ordo stop [<order.yaml>]                              close every session now and exit
  ordo answer [<order.yaml>] <question-id> <text>       answer a question of a blocked task
  ordo check [<order.yaml>]                             validate an order
  ordo logs [<order.yaml>] [-n N] [-f]                  the dispatcher log
  ordo notify-test [<order.yaml>]                       send a test notification

pause, resume, stop, answer, check, logs and notify-test can leave the order out
when exactly one dispatcher is running: the command uses that order. With none or
several running, name the file. start and run always take it.

Environment: ORDO_POOL, ORDO_LOG_LEVEL (console, default warn), ORDO_FILE_LOG_LEVEL
(default info), OPENAI_API_KEY when an order uses the openai plugin, and what the
notifiers of the order need. A .env file in the current directory is read first.`;

const CLAUDE_PLUGIN = "claude-code";
const OPENAI_PLUGIN = "openai";
const KNOWN_PLUGINS = [CLAUDE_PLUGIN, OPENAI_PLUGIN];

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pool: { type: "string" },
      "use-api-key": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      drain: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false },
      lines: { type: "string", short: "n" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") {
    process.stdout.write(`${HELP}\n`);
    return command === undefined && !values.help ? 1 : 0;
  }
  loadEnv();
  const file = rest[0];
  const needFile = (): string => {
    if (file === undefined || file === "")
      throw new OrderError(`usage: ordo ${command} <order.yaml>`);
    return resolve(file);
  };
  const pool = poolOption(values.pool);
  switch (command) {
    case "run":
      return run(needFile(), pool, values["use-api-key"], values.verbose);
    case "start":
      return start(needFile(), pool, values["use-api-key"]);
    case "status":
      return status(file === undefined ? undefined : resolve(file), values.json);
    case "list":
      return list();
    case "pause":
      return control(await orderArg(command, file), { cmd: "pause", drain: values.drain });
    case "resume":
      return control(await orderArg(command, file), { cmd: "resume" });
    case "stop":
      return control(await orderArg(command, file), { cmd: "stop" });
    case "answer":
      return answerCommand(rest);
    case "check":
      return check(await orderArg(command, file));
    case "logs":
      return logs(await orderArg(command, file), values.lines, values.follow);
    case "notify-test":
      return notifyTest(await orderArg(command, file));
    default:
      throw new OrderError(`unknown command ${command}; see ordo help`);
  }
}

function loadEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

function poolOption(flag: string | undefined): number | undefined {
  const value = flag ?? process.env.ORDO_POOL;
  if (value === undefined || value === "") return undefined;
  const pool = Number(value);
  if (!Number.isInteger(pool) || pool < 1)
    throw new OrderError(`pool must be a whole number ≥ 1, got ${value}`);
  return pool;
}

async function run(
  file: string,
  pool: number | undefined,
  useApiKey: boolean,
  verbose: boolean,
): Promise<number> {
  const paths = orderPaths(file);
  mkdirSync(paths.runDir, { recursive: true });
  const logger = createLogger({
    file: paths.log,
    fileLevel: parseLevel(process.env.ORDO_FILE_LOG_LEVEL, "info"),
    consoleLevel: verbose ? "info" : parseLevel(process.env.ORDO_LOG_LEVEL, "warn"),
  });
  const dispatcher = new Dispatcher({
    file,
    cwd: process.cwd(),
    hosts: hostsOf(useApiKey),
    log: logger.log,
    notifiers: (order) => createNotifiers(order.settings?.notify ?? [], { env: process.env }),
    ...(pool === undefined ? {} : { pool }),
  });
  dispatcher.start();
  let closeControl: () => void = () => undefined;
  let unregister: () => void = () => undefined;
  try {
    closeControl = await serveControl(paths.socket, (request) => dispatcher.handle(request));
    unregister = register({
      pid: process.pid,
      order: paths.order,
      cwd: process.cwd(),
      socket: paths.socket,
      startedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    logger.log.error("the control socket is not available", {
      error: error instanceof Error ? error.message : "failed",
    });
    dispatcher.stop();
  }
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts += 1;
    if (interrupts === 1) {
      logger.log.warn("SIGINT: pausing; press Ctrl-C again to stop now");
      dispatcher.pause(false);
    } else dispatcher.stop();
  });
  process.on("SIGTERM", () => {
    dispatcher.stop();
  });
  process.on("SIGHUP", () => undefined);
  const result: RunResult = await dispatcher.result;
  await dispatcher.drained();
  closeControl();
  unregister();
  logger.flush();
  return result.reason === "done" || result.reason === "stopped" ? 0 : 1;
}

async function start(file: string, pool: number | undefined, useApiKey: boolean): Promise<number> {
  parseOrder(readOrderText(file));
  const paths = orderPaths(file);
  const holder = lockHolder(paths);
  if (holder !== null)
    throw new OrderError(`the order is already run by process ${String(holder)}`);
  mkdirSync(paths.runDir, { recursive: true });
  const out = openSync(paths.stderr, "a");
  const args = [...process.execArgv, process.argv[1] ?? "", "run", file];
  if (pool !== undefined) args.push("--pool", String(pool));
  if (useApiKey) args.push("--use-api-key");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  const childState: { exited: number | null } = { exited: null };
  child.on("exit", (code) => {
    childState.exited = code ?? 1;
  });
  child.unref();
  for (let waited = 0; waited < 30_000; waited += 300) {
    await new Promise((done) => setTimeout(done, 300));
    const exited = childState.exited;
    if (exited !== null) {
      process.stderr.write(
        `the dispatcher exited with code ${String(exited)}:\n${tail(paths.stderr, 20)}\n`,
      );
      return 1;
    }
    const reply = await sendControl(paths.socket, { cmd: "status" }, 2000).catch(() => null);
    if (reply?.ok === true) {
      process.stdout.write(
        `started, pid ${String(child.pid)}\nlog: ${paths.log}\nsessions: ${paths.sessions}\n\n${formatStatus(reply.status, Date.now())}\n`,
      );
      return 0;
    }
  }
  process.stderr.write(`the dispatcher did not answer in 30 s; see ${paths.stderr}\n`);
  return 1;
}

/** Orders whose dispatcher answers right now. A registration left by a dead process is skipped. */
async function runningOrders(): Promise<string[]> {
  const orders: string[] = [];
  for (const entry of registrations()) {
    const reply = await sendControl(entry.socket, { cmd: "status" }, 2000).catch(() => null);
    if (reply?.ok === true) orders.push(entry.order);
  }
  return orders;
}

/**
 * The order a command acts on. A given path wins. With none given, the one running dispatcher
 * is used; none or several is an error, because the command would not know which order.
 */
async function orderArg(command: string, file: string | undefined): Promise<string> {
  if (file !== undefined && file !== "") return resolve(file);
  const orders = await runningOrders();
  if (orders.length === 1) {
    const only = orders[0];
    if (only !== undefined) return only;
  }
  if (orders.length === 0) {
    throw new OrderError(`no dispatcher is running; usage: ordo ${command} <order.yaml>`);
  }
  throw new OrderError(`more than one order is running; name it:\n${orders.join("\n")}`);
}

const ANSWER_USAGE = "usage: ordo answer <order.yaml> <question-id> <text>";

/** `answer` puts the order first. When it is omitted, the first word is the question id. */
async function answerCommand(rest: string[]): Promise<number> {
  const [first, ...after] = rest;
  if (first === undefined) throw new OrderError(ANSWER_USAGE);
  const given = resolve(first);
  if (existsSync(given)) {
    const id = after[0];
    const text = after.slice(1).join(" ").trim();
    if (id === undefined || text === "") throw new OrderError(ANSWER_USAGE);
    return answer(given, id, text);
  }
  const orders = await runningOrders();
  if (orders.length === 1) {
    const only = orders[0];
    const text = after.join(" ").trim();
    if (only === undefined || text === "") throw new OrderError(ANSWER_USAGE);
    return answer(only, first, text);
  }
  if (orders.length > 1) {
    throw new OrderError(`more than one order is running; name it:\n${orders.join("\n")}`);
  }
  const id = after[0];
  const text = after.slice(1).join(" ").trim();
  if (id === undefined || text === "") throw new OrderError(ANSWER_USAGE);
  return answer(given, id, text);
}

async function statusOf(file: string): Promise<StatusReport> {
  const reply = await sendControl(orderPaths(file).socket, { cmd: "status" });
  if (reply === null) return fileStatus(parseOrder(readOrderText(file)), file);
  if (!reply.ok) throw new Error(reply.error);
  return reply.status;
}

async function status(file: string | undefined, json: boolean): Promise<number> {
  const files = file === undefined ? registrations().map((entry) => entry.order) : [file];
  const reports: StatusReport[] = [];
  for (const item of files) {
    const report = await statusOf(item);
    if (file === undefined && report.mode === "not-running") continue;
    reports.push(report);
  }
  if (json)
    process.stdout.write(`${JSON.stringify(file === undefined ? reports : reports[0], null, 2)}\n`);
  else if (reports.length === 0) process.stdout.write("no dispatcher is running\n");
  else
    process.stdout.write(
      `${reports.map((report) => formatStatus(report, Date.now())).join("\n\n")}\n`,
    );
  return 0;
}

async function list(): Promise<number> {
  let any = false;
  for (const entry of registrations()) {
    const reply = await sendControl(entry.socket, { cmd: "status" }, 2000).catch(() => null);
    if (reply?.ok !== true) continue;
    any = true;
    const { mode, counts, title } = reply.status;
    process.stdout.write(
      `${String(entry.pid)}\t${mode}\t${String(counts.done)}/${String(Object.values(counts).reduce((a, b) => a + b, 0))} done\t${title}\t${entry.order}\n`,
    );
  }
  if (!any) process.stdout.write("no dispatcher is running\n");
  return 0;
}

async function control(
  file: string,
  request: { cmd: "pause"; drain: boolean } | { cmd: "resume" } | { cmd: "stop" },
): Promise<number> {
  const reply = await sendControl(orderPaths(file).socket, request);
  if (reply === null) {
    process.stderr.write(`no dispatcher runs ${file}\n`);
    return 1;
  }
  if (!reply.ok) {
    process.stderr.write(`${reply.error}\n`);
    return 1;
  }
  process.stdout.write(`${formatStatus(reply.status, Date.now())}\n`);
  return 0;
}

async function answer(file: string, id: string, text: string): Promise<number> {
  const paths = orderPaths(file);
  const reply = await sendControl(paths.socket, { cmd: "answer", id, text });
  if (reply !== null) {
    if (!reply.ok) {
      process.stderr.write(`${reply.error}\n`);
      return 1;
    }
    process.stdout.write(`${formatStatus(reply.status, Date.now())}\n`);
    return 0;
  }
  // No dispatcher: take the lock so none starts while the file is written.
  const release = acquireLock(paths);
  try {
    const before = readOrderText(file);
    const order = answerQuestion(parseOrder(before), id, text, "owner", new Date());
    if (textHash(readOrderText(file)) !== textHash(before))
      throw new Error("the order file changed meanwhile; try again");
    writeAtomic(file, formatOrder(order));
    process.stdout.write(`${formatStatus(fileStatus(order, file), Date.now())}\n`);
  } finally {
    release();
  }
  return 0;
}

function hostsOf(useApiKey: boolean): Record<string, SessionHost> {
  return {
    [CLAUDE_PLUGIN]: claudeHost({ useApiKey }),
    [OPENAI_PLUGIN]: openaiHost({ env: process.env }),
  };
}

async function check(file: string): Promise<number> {
  const order = parseOrder(readOrderText(file));
  const problems: string[] = [];
  const plugins = orderPlugins(order);
  for (const plugin of plugins) {
    if (!KNOWN_PLUGINS.includes(plugin)) {
      problems.push(`no model plugin ${plugin} (known: ${KNOWN_PLUGINS.join(", ")})`);
    }
  }
  if (plugins.has(OPENAI_PLUGIN)) problems.push(...openaiEnvProblems(process.env));
  try {
    createNotifiers(order.settings?.notify ?? [], { env: process.env });
  } catch (error: unknown) {
    problems.push(error instanceof Error ? error.message : "notifiers are not valid");
  }
  const reply = await sendControl(orderPaths(file).socket, { cmd: "status" }, 2000).catch(
    () => null,
  );
  process.stdout.write(`${formatStatus(statusFromReply(order, file, reply), Date.now())}\n`);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    return 1;
  }
  process.stdout.write("ok\n");
  return 0;
}

function tail(path: string, count: number): string {
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  return lines.slice(-count).join("\n");
}

async function logs(file: string, lines: string | undefined, follow: boolean): Promise<number> {
  const path = orderPaths(file).log;
  const count = lines === undefined ? 50 : Number(lines);
  const pretty = (line: string): string => prettyLine(line, true) ?? line;
  const text = tail(path, Number.isInteger(count) && count > 0 ? count : 50);
  if (text !== "") process.stdout.write(`${text.split("\n").map(pretty).join("\n")}\n`);
  if (!follow) return 0;
  let offset = existsSync(path) ? statSync(path).size : 0;
  let rest = "";
  for (;;) {
    await new Promise((done) => setTimeout(done, 1000));
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const chunk = readFileSync(path).subarray(offset, size).toString("utf8");
    offset = size;
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) if (line !== "") process.stdout.write(`${pretty(line)}\n`);
  }
}

async function notifyTest(file: string): Promise<number> {
  const order = parseOrder(readOrderText(file));
  const configs = order.settings?.notify ?? [];
  if (configs.length === 0) {
    process.stderr.write("the order has no settings.notify\n");
    return 1;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (
    configs.some((config) => config.plugin === "telegram") &&
    token !== undefined &&
    token !== "" &&
    (chat === undefined || chat === "")
  ) {
    const chats = await telegramChats(token);
    process.stdout.write(
      chats.length === 0
        ? "TELEGRAM_CHAT_ID is not set and nobody wrote to the bot yet: send the bot a message and run this again.\n"
        : `TELEGRAM_CHAT_ID is not set. Chats that wrote to the bot:\n${chats.map((item) => `  ${String(item.id)}  ${item.name}`).join("\n")}\nPut the id into .env as TELEGRAM_CHAT_ID=<id>.\n`,
    );
    return 1;
  }
  for (const notifier of createNotifiers(configs, { env: process.env })) {
    await notifier.send({
      kind: "test",
      order: order.title,
      text: "If you read this, notifications work.",
    });
    process.stdout.write(`sent via ${notifier.name}\n`);
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 1;
}

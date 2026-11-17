// Where an order keeps its runtime files, the lock, and the atomic write of the order.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { OrderError } from "./order.ts";

export interface OrderPaths {
  /** Absolute path of the order file. */
  order: string;
  /** `<order without .yaml>.ordo/` next to the order: lock, log, transcripts. */
  runDir: string;
  lock: string;
  log: string;
  /** Output of a detached dispatcher before its log is open. */
  stderr: string;
  sessions: string;
  /** Unix socket of the running dispatcher. Kept short: socket paths are limited to ~100 bytes. */
  socket: string;
}

export function orderPaths(file: string, env: NodeJS.ProcessEnv = process.env): OrderPaths {
  const order = resolve(file);
  const name = basename(order).replace(/\.ya?ml$/i, "");
  const runDir = join(dirname(order), `${name}.ordo`);
  const id = createHash("sha256").update(order).digest("hex").slice(0, 16);
  return {
    order,
    runDir,
    lock: join(runDir, "lock"),
    log: join(runDir, "ordo.log"),
    stderr: join(runDir, "stderr.log"),
    sessions: join(runDir, "sessions"),
    socket: join(socketDir(env), `${id}.sock`),
  };
}

/** Directory of the control sockets of this user. */
export function socketDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime !== "") return join(runtime, "ordo");
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `ordo-${uid}`);
}

export function readOrderText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error: unknown) {
    if (isErrno(error) && error.code === "ENOENT") throw new OrderError(`no file ${file}`);
    throw error;
  }
}

/** Write through a temporary file and rename, so a reader never sees half a file. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * Take the lock of an order: a file with the process id. A lock whose process is gone is taken
 * over. Returns the release function.
 */
export function acquireLock(paths: OrderPaths): () => void {
  mkdirSync(paths.runDir, { recursive: true });
  try {
    writeFileSync(paths.lock, `${String(process.pid)}\n`, { flag: "wx" });
  } catch (error: unknown) {
    if (!isErrno(error) || error.code !== "EEXIST") throw error;
    const pid = lockHolder(paths);
    if (pid !== null) throw new OrderError(`the order is already run by process ${String(pid)}`);
    writeFileSync(paths.lock, `${String(process.pid)}\n`);
  }
  return () => {
    rmSync(paths.lock, { force: true });
  };
}

/** The live process that holds the lock, or null. */
export function lockHolder(paths: OrderPaths): number | null {
  let text: string;
  try {
    text = readFileSync(paths.lock, "utf8");
  } catch (error: unknown) {
    if (isErrno(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isErrno(error) && error.code === "EPERM";
  }
}

export function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

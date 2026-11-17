// The control channel of a running dispatcher: a Unix socket, one JSON request and one JSON
// response per connection. The CLI's pause, resume, stop, answer and status go through it.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, connect, createServer } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { isErrno, socketDir } from "./files.ts";
import { StatusReport } from "./status.ts";

export const ControlRequest = z.discriminatedUnion("cmd", [
  z.strictObject({ cmd: z.literal("status") }),
  z.strictObject({ cmd: z.literal("pause"), drain: z.boolean() }),
  z.strictObject({ cmd: z.literal("resume") }),
  z.strictObject({ cmd: z.literal("stop") }),
  z.strictObject({ cmd: z.literal("answer"), id: z.string().min(1), text: z.string().min(1) }),
]);
export type ControlRequest = z.infer<typeof ControlRequest>;

export const ControlResponse = z.union([
  z.strictObject({ ok: z.literal(true), status: StatusReport }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type ControlResponse = z.infer<typeof ControlResponse>;

export type ControlHandler = (request: ControlRequest) => ControlResponse;

/** Listen on `socket`. A socket file left by a dead process is replaced. */
export async function serveControl(socket: string, handle: ControlHandler): Promise<() => void> {
  mkdirSync(join(socket, ".."), { recursive: true, mode: 0o700 });
  if (await answers(socket)) throw new Error(`another dispatcher listens on ${socket}`);
  rmSync(socket, { force: true });
  const server: Server = createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      let response: ControlResponse;
      try {
        const parsed = ControlRequest.safeParse(JSON.parse(line));
        response = parsed.success
          ? handle(parsed.data)
          : { ok: false, error: `bad request: ${parsed.error.message}` };
      } catch (error: unknown) {
        response = { ok: false, error: error instanceof Error ? error.message : "failed" };
      }
      connection.end(`${JSON.stringify(response)}\n`);
    });
    connection.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return () => {
    server.close();
    rmSync(socket, { force: true });
  };
}

/** Send one request. Null when no dispatcher listens on the socket. */
export function sendControl(
  socket: string,
  request: ControlRequest,
  timeoutMs = 10_000,
): Promise<ControlResponse | null> {
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    let buffer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("the dispatcher did not answer in time"));
    }, timeoutMs);
    connection.setEncoding("utf8");
    connection.on("connect", () => {
      connection.write(`${JSON.stringify(request)}\n`);
    });
    connection.on("data", (chunk: string) => {
      buffer += chunk;
    });
    connection.on("end", () => {
      clearTimeout(timer);
      try {
        const parsed = ControlResponse.safeParse(JSON.parse(buffer));
        if (parsed.success) resolve(parsed.data);
        else reject(new Error("the dispatcher sent an unexpected reply"));
      } catch {
        reject(new Error("the dispatcher sent an unexpected reply"));
      }
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      if (isErrno(error) && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        resolve(null);
      } else {
        reject(error);
      }
    });
  });
}

async function answers(socket: string): Promise<boolean> {
  try {
    return (await sendControl(socket, { cmd: "status" }, 2000)) !== null;
  } catch {
    return false;
  }
}

const Registration = z.object({
  pid: z.number(),
  order: z.string(),
  cwd: z.string(),
  socket: z.string(),
  startedAt: z.string(),
});
export type Registration = z.infer<typeof Registration>;

/** Record a running dispatcher so `ordo list` finds it. Returns the removal. */
export function register(entry: Registration, env: NodeJS.ProcessEnv = process.env): () => void {
  const dir = socketDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = entry.socket.replace(/\.sock$/, ".json");
  writeFileSync(file, `${JSON.stringify(entry)}\n`);
  return () => {
    rmSync(file, { force: true });
  };
}

export function registrations(env: NodeJS.ProcessEnv = process.env): Registration[] {
  const dir = socketDir(env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error: unknown) {
    if (isErrno(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const found: Registration[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = Registration.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (parsed.success) found.push(parsed.data);
    } catch {
      // A file being written or removed right now.
    }
  }
  return found;
}

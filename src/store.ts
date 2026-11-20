// Reading and writing an order kept in its three places: the order file, the live file and the
// archive. Archive files are written once, before the live file, so a crash between the two
// leaves a task in both places, and the archive wins on the next read.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { type OrderPaths, readOrderText, writeAtomic } from "./files.ts";
import {
  type ArchivedTask,
  LIVE_KEYS,
  type Order,
  OrderError,
  formatArchived,
  formatLive,
  formatOrder,
  isFinished,
  joinOrder,
  parseArchived,
  parseLive,
  parseOrderFile,
  textHash,
} from "./order.ts";

export interface StoredOrder {
  order: Order;
  /** `single`: everything is still in the order file. `split`: order, live file and archive. */
  layout: "single" | "split";
  /** Hash of the order file as read. */
  headHash: string;
  /** Hash of the live file as read or last written; null for a single file. */
  liveHash: string | null;
  /** Archive number of every archived task, by id. */
  archived: Map<string, number>;
}

/** Read an order in either layout. Throws {@link OrderError} naming the file and the problem. */
export function readStored(paths: OrderPaths): StoredOrder {
  const headText = readOrderText(paths.order);
  const { head, live } = within(paths.order, () => parseOrderFile(headText));
  if (live !== null) {
    if (existsSync(paths.live)) {
      throw new OrderError(
        `${paths.order} holds state and tasks, but ${paths.live} exists too. Keep them in one place: the live file is the dispatcher's.`,
      );
    }
    return {
      order: within(paths.order, () => joinOrder(head, live, [])),
      layout: "single",
      headHash: textHash(headText),
      liveHash: null,
      archived: new Map(),
    };
  }
  if (!existsSync(paths.live)) {
    throw new OrderError(
      `${paths.order} has no state and tasks, and there is no ${paths.live}. Write state and tasks into the order to begin.`,
    );
  }
  const liveText = readOrderText(paths.live);
  const parsed = within(paths.live, () => parseLive(liveText));
  const archived = readArchive(paths.archive);
  return {
    order: within(paths.live, () => joinOrder(head, parsed, archived)),
    layout: "split",
    headHash: textHash(headText),
    liveHash: textHash(liveText),
    archived: new Map(archived.map((item) => [item.task.id, item.seq])),
  };
}

function readArchive(dir: string): ArchivedTask[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => {
      const file = join(dir, name);
      const entry = within(file, () => parseArchived(readOrderText(file)));
      if (`${entry.task.id}.yaml` !== name) {
        throw new OrderError(`${file}: holds task ${entry.task.id}`);
      }
      return entry;
    });
}

function within<T>(file: string, read: () => T): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof OrderError) throw new OrderError(`${file}:\n${error.message}`);
    throw error;
  }
}

export function archiveFile(paths: OrderPaths, id: string): string {
  return join(paths.archive, `${id}.yaml`);
}

/**
 * Move every finished task that is not archived yet into the archive, then write the live file.
 * `archived` is updated in place. Returns the hash of the live file.
 */
export function writeStored(
  paths: OrderPaths,
  order: Order,
  archived: Map<string, number>,
): string {
  let seq = Math.max(0, ...archived.values());
  for (const task of order.tasks) {
    if (!isFinished(task) || archived.has(task.id)) continue;
    mkdirSync(paths.archive, { recursive: true });
    seq += 1;
    writeAtomic(archiveFile(paths, task.id), formatArchived(task, seq));
    archived.set(task.id, seq);
  }
  const text = formatLive(order);
  writeAtomic(paths.live, text);
  return textHash(text);
}

/** Write an order that is still one file back into that file. */
export function writeSingle(paths: OrderPaths, order: Order): string {
  const text = formatOrder(order);
  writeAtomic(paths.order, text);
  return textHash(text);
}

/**
 * Split an order kept in one file: tasks that ran go to the archive, the live part to the live
 * file, and the order file keeps only its head, with the owner's comments.
 */
export function splitOrder(paths: OrderPaths, stored: StoredOrder): StoredOrder {
  if (stored.layout === "split") return stored;
  const archived = new Map<string, number>();
  const liveHash = writeStored(paths, stored.order, archived);
  const doc = parseDocument(readOrderText(paths.order));
  for (const key of LIVE_KEYS) doc.delete(key);
  const head = doc.toString({ lineWidth: 0 });
  writeAtomic(paths.order, head);
  return { order: stored.order, layout: "split", headHash: textHash(head), liveHash, archived };
}

/** Hash of the live file now, or null when it is gone. */
export function liveHashNow(paths: OrderPaths): string | null {
  return existsSync(paths.live) ? textHash(readOrderText(paths.live)) : null;
}

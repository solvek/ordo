// The status a dispatcher reports, and how the CLI prints it.
import { z } from "zod";
import { type Order, STATUSES, countByStatus, openQuestions } from "./order.ts";

export const MODES = [
  "running",
  "replanning",
  "pausing",
  "paused",
  "waiting-limit",
  "waiting-owner",
  "stopping",
  "not-running",
] as const;
export type Mode = (typeof MODES)[number];

export const StatusReport = z.object({
  title: z.string(),
  file: z.string(),
  pid: z.number().nullable(),
  mode: z.enum(MODES),
  /** When the current mode began, ISO time; null when unknown. */
  since: z.string().nullable(),
  pool: z.number().nullable(),
  counts: z.record(z.enum(STATUSES), z.number()),
  running: z.array(z.object({ id: z.string(), title: z.string(), minutes: z.number() })),
  replan: z.object({ queued: z.number(), runningMinutes: z.number().nullable() }),
  questions: z.array(z.object({ id: z.string(), task: z.string(), text: z.string() })),
  limitUntil: z.string().nullable(),
  totals: z.object({ minutes: z.number(), costUsd: z.number(), sessions: z.number() }),
});
export type StatusReport = z.infer<typeof StatusReport>;

/** Status read from the file alone, when no dispatcher runs the order. */
export function fileStatus(order: Order, file: string): StatusReport {
  return {
    title: order.title,
    file,
    pid: null,
    mode: "not-running",
    since: null,
    pool: null,
    counts: countByStatus(order),
    running: [],
    replan: { queued: order.replan?.length ?? 0, runningMinutes: null },
    questions: openQuestions(order).map(({ id, task, text }) => ({ id, task, text })),
    limitUntil: null,
    totals: totals(order),
  };
}

export function totals(order: Order): StatusReport["totals"] {
  let minutes = 0;
  let costUsd = 0;
  let sessions = 0;
  for (const task of order.tasks) {
    if (task.report?.minutes === undefined) continue;
    sessions += 1;
    minutes += task.report.minutes;
    costUsd += task.report.costUsd ?? 0;
  }
  return { minutes: Math.round(minutes), costUsd: Math.round(costUsd * 100) / 100, sessions };
}

function ago(since: string | null, now: number): string {
  if (since === null) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  if (minutes < 60) return ` for ${String(minutes)} min`;
  return ` for ${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

export function formatStatus(status: StatusReport, now: number): string {
  const lines = [
    status.title,
    `  file: ${status.file}`,
    `  mode: ${status.mode}${ago(status.since, now)}${status.pid === null ? "" : `, pid ${String(status.pid)}`}${status.pool === null ? "" : `, pool ${String(status.pool)}`}`,
  ];
  const counts = STATUSES.filter((name) => status.counts[name] > 0)
    .map((name) => `${name} ${String(status.counts[name])}`)
    .join(", ");
  lines.push(`  tasks: ${counts === "" ? "none" : counts}`);
  for (const task of status.running) {
    lines.push(`  running: ${task.id} — ${task.title} (${String(Math.round(task.minutes))} min)`);
  }
  if (status.replan.runningMinutes !== null) {
    lines.push(`  replan: running for ${String(Math.round(status.replan.runningMinutes))} min`);
  }
  if (status.replan.queued > 0)
    lines.push(`  replan: ${String(status.replan.queued)} reason(s) queued`);
  if (status.limitUntil !== null) lines.push(`  usage limit: waiting until ${status.limitUntil}`);
  lines.push(
    `  sessions: ${String(status.totals.sessions)}, ${String(status.totals.minutes)} min, $${status.totals.costUsd.toFixed(2)} (API-equivalent cost)`,
  );
  if (status.questions.length > 0) {
    lines.push(`  open questions: ${String(status.questions.length)}`);
    for (const question of status.questions) {
      lines.push(`    ${question.id} [${question.task}] ${question.text}`);
    }
  }
  return lines.join("\n");
}

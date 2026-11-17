// Texts the dispatcher sends into sessions. Sessions never edit the order file.
import { stringify } from "yaml";
import {
  type Minutes,
  type Order,
  type Question,
  type ReplanItem,
  type Task,
  modelText,
} from "./order.ts";

export function remindText(minutes: Minutes): string {
  return `${String(minutes.remind)} minutes have passed. Estimate what is left and do not start work you cannot hand in by minute ${String(minutes.wrap)}.`;
}

export function wrapText(minutes: Minutes): string {
  return `${String(minutes.wrap)} minutes have passed. Finish the current unit of work, save it and hand in the report. Do not start a new unit.`;
}

export function finishText(minutes: Minutes): string {
  return `${String(minutes.finish)} minutes have passed. Hand in the report now. The session is closed at minute ${String(minutes.stop)} and work not saved by then is lost.`;
}

export const PAUSE_TEXT =
  "The dispatcher is pausing. Finish the current unit of work, save it and hand in the report now. Do not start a new unit. Put what is left in proposal.";

export function timeoutSummary(minutes: Minutes): string {
  return `The dispatcher closed the session at minute ${String(minutes.stop)}, before it handed in a report.`;
}

export const STOP_SUMMARY =
  "The owner stopped the dispatcher before the session handed in a report.";

function block(text: string): string {
  const body = text.trim();
  return body === "" ? "(empty)" : body;
}

function stateText(order: Order): string {
  return Object.keys(order.state).length === 0
    ? "(empty)"
    : stringify(order.state, { lineWidth: 0 }).trimEnd();
}

function taskBlock(task: Task, withPrompt: boolean): string {
  const lines = [
    `- id: ${task.id}`,
    `  title: ${task.title}`,
    `  model: {plugin: ${task.model.plugin}, name: ${task.model.name}${task.model.effort === undefined ? "" : `, effort: ${task.model.effort}`}}`,
  ];
  if (task.after !== undefined) lines.push(`  after: [${task.after.join(", ")}]`);
  if (withPrompt) lines.push(`  prompt: ${task.prompt.trim().replaceAll("\n", "\n    ")}`);
  return lines.join("\n");
}

export interface WorkerPromptInput {
  order: Order;
  task: Task;
  minutes: Minutes;
  pool: number;
  /** Tasks other workers are running right now. */
  running: readonly Task[];
}

/** Opening message of a worker session. */
export function workerPrompt(input: WorkerPromptInput): string {
  const { order, task, minutes } = input;
  const backlog = order.tasks.filter((item) => item.status === "pending" && item.id !== task.id);
  const lines = [
    "You are a worker of Ordo, a dispatcher that runs a long piece of work as short sessions.",
    "You do one task of a work order. Do not edit the order file: the dispatcher keeps it.",
    "Save your results where the task and the context say. Hand the dispatcher only the report the session schema asks for.",
    "",
    `Order: ${order.title}`,
    "",
    "Context:",
    block(order.context),
    "",
    "State:",
    stateText(order),
    "",
    `Your task: ${task.id}. ${task.title}`,
    block(task.prompt),
    "",
    "Backlog: tasks not started yet. Do not do them; propose changes to them in proposal.",
    backlog.length === 0 ? "(empty)" : backlog.map((item) => taskBlock(item, true)).join("\n"),
  ];
  if (input.pool > 1) {
    lines.push(
      "",
      `Up to ${String(input.pool)} workers run at the same time in the same directory. Touch only what your task names.`,
      input.running.length === 0
        ? "No other task is running right now."
        : `Running now: ${input.running.map((item) => `${item.id} (${item.title})`).join("; ")}.`,
    );
  }
  lines.push(
    "",
    "Report:",
    "- outcome: done when the task is complete; failed when it cannot be completed as given (say why, and put what is left in proposal); blocked when it cannot go on without the owner's answers (ask them in questions).",
    "- summary: a few sentences on what was done.",
    "- proposal: what to add, drop or split in the backlog. Empty when the backlog stays. A non-empty proposal calls the planner, so do not put notes here.",
    "- note: something the owner or a later task should see when the backlog stays as it is. Omit it when there is nothing. A note does not call the planner. Later sessions do not read this report, so also save the note where the order context says.",
    "- questions: only with blocked. Each question self-contained: the owner reads it on a phone.",
    "- statePatch: only the top-level state keys that changed, each with its full new value; null removes a key. Omit it when the state did not change.",
    "Write summary, proposal and questions in the language of the order context.",
    "",
    "Rules:",
    "- When you hand in the report the session ends, and nothing may keep running in the background. If you have to wait for something, wait with one blocking command.",
    `- Time reminders come as separate messages. At minute ${String(minutes.remind)} estimate what is left. At minute ${String(minutes.wrap)} finish the current unit of work and hand in. At minute ${String(minutes.finish)} hand in at once. At minute ${String(minutes.stop)} the session is closed and unsaved work is lost, so save results as you go.`,
  );
  return lines.join("\n");
}

function reasonText(order: Order, item: ReplanItem): string {
  const task = order.tasks.find((entry) => entry.id === item.task);
  const title = task === undefined ? item.task : `${item.task} (${task.title})`;
  const minutes = task?.report?.minutes;
  const at = minutes === undefined ? "" : ` at minute ${String(Math.round(minutes))}`;
  switch (item.reason) {
    case "proposal":
      return `Task ${title} is done. Its worker proposes:\n${block(item.text)}`;
    case "failed":
      return `Task ${title} failed. Report: ${task?.report?.summary ?? "(none)"}\nProposal:\n${block(item.text)}`;
    case "interrupted":
      return `Task ${title} was interrupted${at} (${task?.report?.reason ?? "unknown"}) before a full report. ${task?.report?.summary ?? ""}\n${item.text.trim() === "" ? "" : `Proposal:\n${item.text.trim()}\n`}Look at what it left (the files and state the task names) and plan the rest; do not redo what is finished.`;
    case "limit":
      return `Task ${title} was cut off by the usage limit of the account${at}, without a report. Look at what its worker left (the files and state the task names) and rewrite the backlog so the unfinished part gets done properly. Do not redo what is finished, and do not simply repeat the whole task when part of it is done.`;
    case "answers":
      return `Task ${title} was blocked on questions to the owner. They are answered now:\n${item.text}\nPlan how the work goes on with these answers.`;
  }
}

export interface PlannerPromptInput {
  order: Order;
  items: readonly ReplanItem[];
  minutes: Minutes;
  pool: number;
}

/** Opening message of a planner session. It rewrites the backlog and the state, nothing that ran. */
export function plannerPrompt(input: PlannerPromptInput): string {
  const { order, items, minutes } = input;
  const ran = order.tasks.filter((task) => task.status !== "pending" && task.status !== "running");
  const running = order.tasks.filter((task) => task.status === "running");
  const backlog = order.tasks.filter((task) => task.status === "pending");
  const seen = new Map<string, string>();
  for (const task of order.tasks) {
    seen.set(
      `${task.model.plugin}/${task.model.name}/${task.model.effort ?? ""}`,
      modelText(task.model),
    );
  }
  const models = [...seen.values()].map((text) => `- ${text}`).join("\n");
  const ranText =
    ran.length === 0
      ? "(none)"
      : ran
          .map((task) => {
            const report = task.report;
            const note =
              report?.note === undefined || report.note.trim() === ""
                ? ""
                : `\n  note: ${report.note}`;
            return `- ${task.id} ${task.status}: ${task.title}\n  summary: ${report?.summary ?? ""}\n  proposal: ${report?.proposal ?? ""}${note}`;
          })
          .join("\n");
  const lines = [
    "You are the planner of a work order run by Ordo. You patch the backlog: the tasks not started yet.",
    "Do not edit the order file or any other file. You may read files to see what workers left. The dispatcher writes your reply into the order.",
    "Return only the change. Tasks and state keys you do not mention stay as they are.",
    "- statePatch: only the top-level state keys that change, each with its full new value; null removes a key. Omit it when the state stays.",
    "- remove: ids of pending tasks to drop. Omit it when you drop none.",
    "- upsert: tasks to add or replace. An id that is already pending is replaced; send the whole task. A new id is added. Do not send a task that stays as it is.",
    "- order: every pending task id after your change, in the order they should run. Required when you add, remove or reorder. Omit it when you only replace tasks in place or change nothing.",
    "Tasks that ran or are running stay as they are. Do not reuse their ids.",
    `A task must fit in one session of about ${String(minutes.wrap)} minutes. Split larger work.`,
    "Use after for every real dependency. A task without after may start as soon as a worker is free.",
    input.pool > 1
      ? `Up to ${String(input.pool)} tasks run at the same time in the same directory: tasks that write the same files must be ordered with after.`
      : "Tasks run one at a time, in backlog order.",
    "",
    "Each task names its model as {plugin, name, effort}. Models the order uses so far:",
    models === "" ? "(none)" : models,
    `You run as ${modelText(order.planner)}. Do not give tasks this model unless the reason below asks for it explicitly; prefer the cheapest model that can do the task. A task that needs no tools may use a plugin without them, when the order uses one.`,
    "",
    "Why you are called:",
    items.map((item) => reasonText(order, item)).join("\n\n"),
    "",
    `Order: ${order.title}`,
    "",
    "Context:",
    block(order.context),
    "",
    "State:",
    stateText(order),
    "",
    "Tasks that ran:",
    ranText,
    "",
    "Running now (keep away from their work):",
    running.length === 0
      ? "(none)"
      : running.map((task) => `- ${task.id}: ${task.title}`).join("\n"),
    "",
    "Current backlog:",
    backlog.length === 0 ? "(empty)" : backlog.map((task) => taskBlock(task, true)).join("\n"),
  ];
  return lines.join("\n");
}

/** Opening message of a decider session. */
export function deciderPrompt(order: Order, questions: readonly Question[]): string {
  const asked = questions
    .map((question) => {
      const task = order.tasks.find((item) => item.id === question.task);
      const summary = task?.report?.summary ?? "";
      return `- id: ${question.id}\n  task: ${question.task}${task === undefined ? "" : ` (${task.title})`}\n  worker's summary: ${summary}\n  question: ${question.text}`;
    })
    .join("\n");
  return [
    "You answer questions a worker of a work order asked the owner. Ordo runs the order.",
    "Answer only where the context, the state and the files give a clear answer. Leave the answer empty when they do not, or when the decision belongs to the owner: the owner then answers it.",
    "Do not edit any file. Answer in the language of the question.",
    "",
    `Order: ${order.title}`,
    "",
    "Context:",
    block(order.context),
    "",
    "State:",
    stateText(order),
    "",
    "Questions:",
    asked,
  ].join("\n");
}

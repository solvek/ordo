// The `claude-code` model plugin: a Claude Code session kept open through the Agent SDK, so the
// dispatcher can write time reminders into it. One-shot `claude -p` cannot take a message in the
// middle of a task.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { type LimitSignal, limitWatch } from "./limit.ts";
import {
  type RunningSession,
  type SendPriority,
  type SessionAnswer,
  type SessionHost,
} from "./session.ts";
import { contentLines, prefixed } from "./transcript.ts";

export interface ClaudeHostOptions {
  /**
   * Pass `ANTHROPIC_API_KEY` into the session. Off by default: sessions use the Claude Code
   * login of the machine, and a key in the environment would switch them to API billing.
   */
  useApiKey?: boolean;
  /** Environment the sessions start from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Linux: how much more likely the kernel should pick a session over the dispatcher when memory
 * runs out. A session that dies is reported as failed; a dispatcher that dies stops the order.
 */
const SESSION_OOM_SCORE = 500;

export function claudeHost(options: ClaudeHostOptions = {}): SessionHost {
  const baseEnv = options.env ?? process.env;
  return {
    open(request) {
      const log = request.transcript;
      const abort = new AbortController();
      const queue = messageQueue();
      let closed = false;
      let sawUuid = false;
      let latest = randomUUID();
      let settled = false;
      let resolveAnswer: (answer: SessionAnswer) => void = () => undefined;
      let rejectAnswer: (error: Error) => void = () => undefined;
      const finished = new Promise<SessionAnswer>((resolve, reject) => {
        resolveAnswer = resolve;
        rejectAnswer = reject;
      });
      // A rejection nobody awaits yet must not crash the process.
      finished.catch(() => undefined);

      const settle = (answer: SessionAnswer): void => {
        if (settled) return;
        settled = true;
        resolveAnswer(answer);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        rejectAnswer(error);
      };

      const key = baseEnv.ANTHROPIC_API_KEY;
      const hasKey = key !== undefined && key !== "";
      if (!hasKey) log("env: no ANTHROPIC_API_KEY in the environment");
      else if (options.useApiKey === true) log("env: ANTHROPIC_API_KEY passed into the session");
      else log("env: ANTHROPIC_API_KEY was in the environment and is not passed into the session");
      if (runningAsRoot()) {
        log(
          "env: running as root, IS_SANDBOX=1 set so Claude Code allows skipping permission prompts",
        );
      }
      log(
        `session open role=${request.role} model=${request.model} effort=${request.effort ?? "default"} cwd=${request.cwd}`,
      );
      queue.push(userMessage(request.prompt, latest));
      const stream = query({
        prompt: queue.stream,
        options: {
          model: request.model,
          ...(request.effort === undefined ? {} : { effort: request.effort }),
          cwd: request.cwd,
          abortController: abort,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          persistSession: false,
          disallowedTools: [...request.disallowedTools],
          outputFormat: { type: "json_schema", schema: request.schema },
          env: sessionEnv(baseEnv, options.useApiKey === true),
          spawnClaudeCodeProcess: (spawnOptions) => spawnSession(spawnOptions, log),
        },
      });
      void stream.accountInfo().then(
        (info) => {
          log(
            `account email=${info.email ?? "?"} organization=${info.organization ?? "?"} subscription=${info.subscriptionType ?? "?"} token=${info.tokenSource ?? "?"} apiKey=${info.apiKeySource ?? "?"} provider=${info.apiProvider ?? "?"}`,
          );
        },
        (error: unknown) => {
          log(`account unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
        },
      );

      const seeLimit = limitWatch();
      void streamLoop(stream, (message) => {
        for (const line of messageLines(message)) log(line);
        if (message.type === "rate_limit_event") {
          const info = message.rate_limit_info;
          if (info.rateLimitType !== undefined) {
            request.onUsage?.({ type: info.rateLimitType, utilization: info.utilization });
          }
        }
        const signal = limitSignal(message);
        const limit = signal === null ? null : seeLimit(signal);
        if (limit !== null) {
          log(`limit reached resetsAt=${limit.resetsAt?.toISOString() ?? "?"}`);
          fail(limit);
          return;
        }
        if (!isSuccess(message)) return;
        const ids = message.user_message_uuids;
        const one = message.user_message_uuid;
        if (ids === undefined && one === undefined) {
          if (!sawUuid) settle(answerOf(message));
          return;
        }
        sawUuid = true;
        if (ids?.includes(latest) === true || one === latest) settle(answerOf(message));
      }).then(
        () => {
          log("session stream ended");
          fail(new Error("the session ended without a result"));
        },
        (error: unknown) => {
          const text = error instanceof Error ? error.message : "session ended";
          log(`session stream error: ${text}`);
          fail(error instanceof Error ? error : new Error("session ended"));
        },
      );

      const running: RunningSession = {
        send(text, priority) {
          if (closed || settled) return;
          latest = randomUUID();
          log(`send priority=${priority}`);
          for (const line of prefixed("send", text)) log(line);
          queue.push(userMessage(text, latest, priority));
        },
        finished,
        close() {
          if (closed) return;
          closed = true;
          log("session close");
          fail(new Error("the session was closed"));
          queue.close();
          abort.abort();
          stream.close();
        },
      };
      return running;
    },
  };
}

/** Start Claude Code with its stderr in the transcript and, on Linux, an easier target for OOM. */
function spawnSession(options: SpawnOptions, log: (line: string) => void): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    for (const line of prefixed("stderr", data.trimEnd())) log(line);
  });
  if (process.platform === "linux" && child.pid !== undefined) {
    try {
      writeFileSync(`/proc/${String(child.pid)}/oom_score_adj`, String(SESSION_OOM_SCORE));
    } catch {
      // Not fatal: the session only loses its place in the OOM queue.
    }
  }
  return child;
}

function answerOf(message: Extract<SDKResultMessage, { subtype: "success" }>): SessionAnswer {
  return {
    text: message.result,
    structured: message.structured_output,
    usage: {
      turns: message.num_turns,
      costUsd: message.total_cost_usd,
      durationMs: message.duration_ms,
    },
  };
}

function brief(message: SDKMessage): string {
  const bits: string[] = [];
  for (const [key, value] of Object.entries(message)) {
    if (key === "type" || key === "uuid" || key === "session_id") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      bits.push(`${key}=${String(value)}`);
    }
  }
  return bits.length === 0 ? message.type : `${message.type} ${bits.join(" ")}`;
}

function isSuccess(
  message: SDKMessage,
): message is Extract<SDKResultMessage, { subtype: "success" }> {
  return message.type === "result" && message.subtype === "success";
}

/** What a stream message says about the usage limit of the account (limit.ts). */
function limitSignal(message: SDKMessage): LimitSignal | null {
  switch (message.type) {
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      // Extra usage keeps requests going after the plan limit is used up.
      const overage = info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
      if (info.status !== "rejected" || overage) return { type: "allowed" };
      return { type: "rejected", resetsAt: resetDate(info.resetsAt) };
    }
    case "assistant":
      return message.error === "rate_limit" ? { type: "refused" } : null;
    case "result":
      return message.subtype !== "success" || message.is_error ? { type: "error-result" } : null;
    default:
      return null;
  }
}

/** The reset time comes as seconds since the epoch; a value in milliseconds is taken as it is. */
export function resetDate(value: number | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return new Date(value < 100_000_000_000 ? value * 1000 : value);
}

function messageLines(message: SDKMessage): string[] {
  switch (message.type) {
    case "system":
      return systemLines(message);
    case "assistant": {
      const lines = contentLines(message.message.content);
      const tagged = lines.map((line) => `assistant ${line}`);
      if (message.error === undefined) return tagged;
      return [`assistant error=${message.error}`, ...tagged];
    }
    case "user":
      return contentLines(message.message.content).map((line) => `user ${line}`);
    case "result":
      return resultLines(message);
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      return [
        `rate_limit status=${info.status} type=${info.rateLimitType ?? "?"} utilization=${info.utilization === undefined ? "?" : String(info.utilization)}`,
      ];
    }
    default:
      return [brief(message)];
  }
}

function systemLines(message: SDKMessage & { type: "system" }): string[] {
  if (message.subtype !== "init") return [`system ${message.subtype}`];
  const mcp = message.mcp_servers.map((server) => `${server.name}:${server.status}`).join(", ");
  const lines = [
    `system init model=${message.model} apiKeySource=${message.apiKeySource} version=${message.claude_code_version} permission=${message.permissionMode} cwd=${message.cwd}`,
    `system tools: ${message.tools.join(", ")}`,
    `system skills: ${message.skills.join(", ")}`,
    `system mcp: ${mcp === "" ? "(none)" : mcp}`,
  ];
  for (const failure of message.plugin_errors ?? []) {
    lines.push(`system plugin error ${failure.plugin} ${failure.type}: ${failure.message}`);
  }
  return lines;
}

function resultLines(message: SDKResultMessage): string[] {
  const head = `result ${message.subtype} turns=${String(message.num_turns)} cost=$${message.total_cost_usd.toFixed(4)} duration=${String(message.duration_ms)}ms`;
  if (message.subtype !== "success") {
    return [head, ...message.errors.map((error) => `result error: ${error}`)];
  }
  const lines = [head, ...prefixed("result text", message.result)];
  if (message.structured_output !== undefined) {
    lines.push(...prefixed("result structured", JSON.stringify(message.structured_output)));
  }
  for (const denial of message.permission_denials) {
    lines.push(`result denied ${denial.tool_name}`);
  }
  return lines;
}

async function streamLoop(
  stream: AsyncIterable<SDKMessage>,
  onMessage: (message: SDKMessage) => void,
): Promise<void> {
  for await (const message of stream) onMessage(message);
}

function userMessage(
  text: string,
  uuid: ReturnType<typeof randomUUID>,
  priority?: SendPriority,
): SDKUserMessage {
  const message: SDKUserMessage = {
    type: "user",
    uuid,
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
  if (priority !== undefined) {
    message.priority = priority;
    message.client_composed = true;
  }
  if (priority === "now") message.origin = { kind: "human" };
  return message;
}

interface MessageQueue {
  stream: AsyncIterable<SDKUserMessage>;
  push(message: SDKUserMessage): void;
  close(): void;
}

function messageQueue(): MessageQueue {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = items.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    push(message) {
      items.push(message);
      const notify = wake;
      wake = undefined;
      notify?.();
    },
    close() {
      closed = true;
      const notify = wake;
      wake = undefined;
      notify?.();
    },
  };
}

/** Child env, by default without the API key that would bill Claude Code as API traffic. */
export function sessionEnv(base: NodeJS.ProcessEnv, useApiKey: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === "ANTHROPIC_API_KEY" && !useApiKey) continue;
    env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "ordo";
  // Claude Code refuses to skip permission prompts when the process is root, unless it
  // believes it is already inside a sandbox. The dispatcher has nobody to ask.
  if (runningAsRoot()) env.IS_SANDBOX = "1";
  return env;
}

function runningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

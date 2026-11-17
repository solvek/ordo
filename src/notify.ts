// Notifications to the owner. Each entry of `settings.notify` names a plugin; secrets come from
// the environment, never from the order file.
import { spawn } from "node:child_process";
import { z } from "zod";
import { type NotifierConfig, OrderError } from "./order.ts";

export type NoticeKind = "questions" | "done" | "error" | "limit" | "usage" | "test";

export interface Notice {
  kind: NoticeKind;
  /** The order title. */
  order: string;
  text: string;
}

export interface Notifier {
  readonly name: string;
  send(notice: Notice): Promise<void>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface NotifierDeps {
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

export interface NotifierPlugin {
  readonly name: string;
  /** Validate the options and the environment. Throws {@link OrderError} on a problem. */
  create(config: NotifierConfig, deps: NotifierDeps): Notifier;
}

const NOTICE_TITLES: Record<NoticeKind, string> = {
  questions: "Questions to the owner",
  done: "Order done",
  error: "Dispatcher stopped",
  limit: "Waiting for the usage limit",
  usage: "Usage limit nearly used up",
  test: "Test notification",
};

export function noticeText(notice: Notice): string {
  return `Ordo · ${notice.order}\n${NOTICE_TITLES[notice.kind]}\n\n${notice.text}`;
}

const TelegramOptions = z.strictObject({
  plugin: z.literal("telegram"),
  tokenEnv: z.string().min(1).default("TELEGRAM_BOT_TOKEN"),
  chatEnv: z.string().min(1).default("TELEGRAM_CHAT_ID"),
});

/** Telegram Bot API. A message limit is 4096 characters; longer text is cut. */
export const telegramPlugin: NotifierPlugin = {
  name: "telegram",
  create(config, deps) {
    const parsed = TelegramOptions.safeParse(config);
    if (!parsed.success) throw new OrderError(`settings.notify telegram: ${parsed.error.message}`);
    const token = deps.env[parsed.data.tokenEnv];
    const chat = deps.env[parsed.data.chatEnv];
    if (token === undefined || token === "") {
      throw new OrderError(`settings.notify telegram: ${parsed.data.tokenEnv} is not set`);
    }
    if (chat === undefined || chat === "") {
      throw new OrderError(
        `settings.notify telegram: ${parsed.data.chatEnv} is not set (ordo notify-test lists the chats that wrote to the bot)`,
      );
    }
    const send = deps.fetch ?? fetchJson;
    return {
      name: "telegram",
      async send(notice) {
        const response = await send(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: noticeText(notice).slice(0, 4000) }),
        });
        if (!response.ok) {
          throw new Error(`telegram answered ${String(response.status)}: ${await response.text()}`);
        }
      },
    };
  },
};

/** Chats that wrote to the bot lately, so the owner can find the chat id. */
export async function telegramChats(
  token: string,
  fetcher: FetchLike = fetchJson,
): Promise<{ id: number; name: string }[]> {
  const response = await fetcher(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`telegram answered ${String(response.status)}`);
  const Updates = z.object({
    result: z.array(
      z.object({
        message: z
          .object({
            chat: z.object({
              id: z.number(),
              username: z.string().optional(),
              first_name: z.string().optional(),
              title: z.string().optional(),
            }),
          })
          .optional(),
      }),
    ),
  });
  const parsed = Updates.safeParse(JSON.parse(await response.text()));
  if (!parsed.success) throw new Error("telegram getUpdates: unexpected reply");
  const chats = new Map<number, string>();
  for (const update of parsed.data.result) {
    const chat = update.message?.chat;
    if (chat === undefined) continue;
    chats.set(chat.id, chat.title ?? chat.username ?? chat.first_name ?? "");
  }
  return [...chats].map(([id, name]) => ({ id, name }));
}

const CommandOptions = z.strictObject({
  plugin: z.literal("command"),
  command: z.string().min(1),
});

/**
 * Any shell command. It gets the text on stdin and ORDO_NOTICE_KIND, ORDO_ORDER in the env;
 * a non-zero exit is a failed notification.
 */
export const commandPlugin: NotifierPlugin = {
  name: "command",
  create(config, deps) {
    const parsed = CommandOptions.safeParse(config);
    if (!parsed.success) throw new OrderError(`settings.notify command: ${parsed.error.message}`);
    const command = parsed.data.command;
    return {
      name: "command",
      send(notice) {
        return new Promise((resolve, reject) => {
          const child = spawn("sh", ["-c", command], {
            env: { ...deps.env, ORDO_NOTICE_KIND: notice.kind, ORDO_ORDER: notice.order },
            stdio: ["pipe", "ignore", "pipe"],
          });
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (data: string) => {
            stderr += data;
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`notify command exited ${String(code)}: ${stderr.trim()}`));
          });
          child.stdin.end(noticeText(notice));
        });
      },
    };
  },
};

export const BUILTIN_NOTIFIERS: readonly NotifierPlugin[] = [telegramPlugin, commandPlugin];

export function createNotifiers(
  configs: readonly NotifierConfig[],
  deps: NotifierDeps,
  plugins: readonly NotifierPlugin[] = BUILTIN_NOTIFIERS,
): Notifier[] {
  return configs.map((config) => {
    const plugin = plugins.find((item) => item.name === config.plugin);
    if (plugin === undefined) {
      throw new OrderError(
        `settings.notify: no notifier plugin ${config.plugin} (known: ${plugins.map((item) => item.name).join(", ")})`,
      );
    }
    return plugin.create(config, deps);
  });
}

async function fetchJson(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
}

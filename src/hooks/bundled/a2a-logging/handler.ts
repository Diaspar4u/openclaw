/**
 * Agent-to-Agent Logging Hook Handler
 *
 * Posts formatted log entries to a Telegram topic when agents
 * communicate via sessions_send, providing real-time visibility
 * into inter-agent messaging.
 */

import { resolveTelegramFetch } from "../../../../extensions/telegram/src/fetch.js";
import { resolveTelegramToken } from "../../../../extensions/telegram/src/token.js";
import { type HookConfig, type OpenClawConfig, loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentToAgentEvent, type InternalHookHandler } from "../../internal-hooks.js";

const log = createSubsystemLogger("a2a-logging");

// Warn-once per key: config issues (missing chatId/token) are permanent until
// gateway restart, so repeating the warning on every event adds noise without
// actionable value. The set resets naturally on process restart.
const warningSuppressed = new Set<string>();

export function resolveA2AConfig(cfg: OpenClawConfig): HookConfig | undefined {
  const hookConfig = resolveHookConfig(cfg, "a2a-logging");
  if (!hookConfig || hookConfig.enabled === false) {
    return undefined;
  }
  return hookConfig;
}

export function resolveToken(cfg: OpenClawConfig, hookToken: string | undefined): string {
  if (hookToken) {
    return hookToken;
  }
  try {
    const resolved = resolveTelegramToken(cfg);
    return resolved.token;
  } catch (err) {
    log.warn(
      `a2a-logging: failed to resolve Telegram token: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
}

export function formatA2ALogMessage(
  sourceAgentId: string,
  targetAgentId: string,
  message: string,
  timestamp: Date,
): string {
  const time = formatTimestamp(timestamp);
  const preview = truncateMessage(message, 200);
  return `<code>[${time}]</code> <b>${escapeHtml(sourceAgentId)}</b> -> <b>${escapeHtml(targetAgentId)}</b>\n${escapeHtml(preview)}`;
}

function formatTimestamp(date: Date): string {
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function truncateMessage(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) {
    return msg;
  }
  return msg.slice(0, maxLen) + "...";
}

export async function postToTelegram(
  token: string,
  chatId: string,
  topicId: number | undefined,
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_notification: true,
  };
  if (topicId !== undefined) {
    body.message_thread_id = topicId;
  }

  const telegramFetch = resolveTelegramFetch();
  const response = await telegramFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Telegram API ${response.status}: ${errorBody}`);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const handler: InternalHookHandler = async (event) => {
  if (!isAgentToAgentEvent(event)) {
    return;
  }

  try {
    const cfg = loadConfig();
    const hookConfig = resolveA2AConfig(cfg);
    if (!hookConfig) {
      return;
    }

    // Validate individual fields from generic HookConfig (session-memory pattern)
    const chatId = typeof hookConfig.chatId === "string" ? hookConfig.chatId : undefined;
    const topicId = typeof hookConfig.topicId === "number" ? hookConfig.topicId : undefined;
    const hookToken = typeof hookConfig.token === "string" ? hookConfig.token : undefined;

    if (!chatId) {
      if (!warningSuppressed.has("chatId")) {
        log.warn(
          "a2a-logging enabled but chatId not configured. Set hooks.internal.entries.a2a-logging.chatId",
        );
        warningSuppressed.add("chatId");
      }
      return;
    }

    const token = resolveToken(cfg, hookToken);
    if (!token) {
      if (!warningSuppressed.has("token")) {
        log.warn(
          "a2a-logging enabled but no Telegram bot token found. Set hooks.internal.entries.a2a-logging.token or configure channels.telegram.botToken",
        );
        warningSuppressed.add("token");
      }
      return;
    }

    const { sourceAgentId, targetAgentId, message: msg } = event.context;
    const text = formatA2ALogMessage(sourceAgentId, targetAgentId, msg, event.timestamp);
    await postToTelegram(token, chatId, topicId, text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to log A2A message: ${message}`);
  }
};

export default handler;

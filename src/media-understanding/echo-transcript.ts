import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";

let echoRuntimePromise: Promise<typeof import("./echo-transcript.runtime.js")> | null = null;

function loadEchoRuntime() {
  echoRuntimePromise ??= import("./echo-transcript.runtime.js");
  return echoRuntimePromise;
}

export const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';

function formatEchoTranscript(transcript: string, format: string): string {
  return format.replace("{transcript}", transcript);
}

/**
 * Sends the transcript echo back to the originating chat.
 * Best-effort: logs on failure, never throws.
 *
 * Uses channel plugin resolution (normalizeChannelId) for proper account-aware,
 * thread-aware delivery. Bypasses reply normalization (no responsePrefix) and
 * passes bestEffort: true so transient failures don't queue stale echoes.
 */
export async function sendTranscriptEcho(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  transcript: string;
  format?: string;
}): Promise<void> {
  const { ctx, cfg, transcript } = params;
  const channel = ctx.Provider ?? ctx.Surface ?? "";
  const to = ctx.OriginatingTo ?? ctx.From ?? "";

  if (!channel || !to) {
    if (shouldLogVerbose()) {
      logVerbose("media: echo-transcript skipped (no channel/to resolved from ctx)");
    }
    return;
  }

  try {
    const { normalizeChannelId, deliverOutboundPayloads } = await loadEchoRuntime();
    const channelId = normalizeChannelId(channel);
    if (!channelId) {
      if (shouldLogVerbose()) {
        logVerbose(`media: echo-transcript skipped (channel "${String(channel)}" is not routable)`);
      }
      return;
    }

    const text = formatEchoTranscript(transcript, params.format ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT);

    await deliverOutboundPayloads({
      cfg,
      channel: channelId,
      to,
      accountId: ctx.AccountId ?? undefined,
      threadId: ctx.MessageThreadId ?? undefined,
      payloads: [{ text }],
      bestEffort: true,
    });
    if (shouldLogVerbose()) {
      logVerbose(`media: echo-transcript sent to ${channel}/${to}`);
    }
  } catch (err) {
    logVerbose(`media: echo-transcript delivery failed: ${String(err)}`);
  }
}

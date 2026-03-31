/**
 * Response Validator — gates outbound agent replies.
 *
 * Ports Claude Code's stop-validator.sh regex checks + Haiku scope/completeness
 * validator into an OpenClaw plugin that runs on every message_sending hook.
 *
 * Hooks used:
 *   message_received  — capture user's last message for Haiku context
 *   llm_output        — capture sessionKey for retry injection correlation
 *   message_sending   — primary validation gate (async, awaited, can cancel)
 */

import { readFile } from "node:fs/promises";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// ── Regex patterns (ported from stop-validator.sh) ───────────────────

const HEDGE_WORDS = ["likely", "probably", "might", "perhaps", "possibly", "presumably", "maybe"];

const DEFERRAL_RE =
  /action needed|action required|you (?:should|may want to|can) (?:verify|check|confirm|review|ensure)|needs (?:verification|confirmation|review)|to be (?:verified|confirmed|validated)|recommend (?:verifying|checking|confirming)|worth (?:checking|verifying|reviewing)/i;

const PLEASANTRY_RE =
  /^(?:You're right|You are right|That's right|Good point|Great question|Absolutely|Indeed|Exactly)/im;

const SELF_FLAG_RE = /I should have|I should've|I failed to|I didn't|I missed|I neglected/i;

const COMMITMENT_RE =
  /from now on|going forward.*I will|I(?:'ll| will) (?:make sure|ensure|always|start|change|update|remember)|won't happen again|I(?:'ll| will) keep that in mind|I'll do better/i;

const CHECK_IF_RE = /check if you have|check if you.*have|check whether you have/i;

const STATUS_Q_RE =
  /anything (?:outstanding|remaining|left|else|missing)|is (?:that|this|it|everything) (?:done|it|all|complete)|are we (?:done|good)|what's (?:left|remaining|outstanding)|status\??$|done\??$/i;

const RECAP_RE =
  /(?:here'?s|here is) (?:what|everything) (?:we'?ve|I'?ve|was) (?:done|completed|accomplished|changed|updated|fixed)|changes (?:made|applied|completed)|summary of (?:changes|work|what)|for (?:reference|completeness|context):|to (?:recap|summarize|sum up)|as a reminder/i;

// ── State (in-memory, per channel:account) ───────────────────────────
// Keyed by channelId:accountId — NOT per-conversation. The message_sending hook
// ctx (PluginHookMessageContext at src/plugins/types.ts:1642-1646) provides
// channelId and accountId but NOT conversationId, so per-conversation scoping
// is not possible from this hook. For multi-conversation channels (e.g. Telegram
// forum topics), the most recent user message / session context / retry counter
// is shared across conversations under the same channel+account.

type Stamped<T> = T & { ts: number };

const userMessages = new Map<string, Stamped<{ content: string }>>();
const sessionCtx = new Map<string, Stamped<{ sessionKey: string; agentId: string }>>();
const retryCounts = new Map<string, Stamped<{ count: number }>>();

const TTL_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;

function ctxKey(ctx: { channelId: string; accountId?: string }): string {
  return `${ctx.channelId}:${ctx.accountId ?? ""}`;
}

function prune<T extends { ts: number }>(map: Map<string, T>): void {
  const cutoff = Date.now() - TTL_MS * 2;
  for (const [k, v] of map) {
    if (v.ts < cutoff) map.delete(k);
  }
}

// ── Regex validation ─────────────────────────────────────────────────

function stripExemptions(text: string): string {
  return text.replace(/_([a-zA-Z]+)_/g, "EXEMPT");
}

function checkRegex(text: string, userMsg: string | undefined): string | null {
  const cleaned = stripExemptions(text);

  for (const word of HEDGE_WORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(cleaned)) {
      return `BLOCKED: You used "${word}". This is an UNVERIFIED CLAIM. Verify the claim, then restate with verified facts. If you cannot verify, say "I don't know".`;
    }
  }

  if (CHECK_IF_RE.test(text)) {
    return 'BLOCKED: You told the user to "check if you have" something. YOU have the tools to check. Go check it yourself and report the RESULT.';
  }

  if (DEFERRAL_RE.test(cleaned)) {
    return "BLOCKED: You deferred work to the user. Do it yourself and report the result.";
  }

  if (PLEASANTRY_RE.test(cleaned)) {
    return "BLOCKED: Response starts with a pleasantry. Remove it and lead with substance.";
  }

  if (SELF_FLAG_RE.test(cleaned)) {
    return "BLOCKED: Self-flagellation detected. Give the ROOT CAUSE and an actionable fix.";
  }

  if (COMMITMENT_RE.test(cleaned)) {
    return "BLOCKED: Verbal commitment without structural change. Edit the relevant file or retract.";
  }

  // Recap/padding on status questions
  if (userMsg && STATUS_Q_RE.test(userMsg)) {
    if (RECAP_RE.test(cleaned)) {
      return "BLOCKED: Status question got a recap. Answer ONLY the question asked.";
    }
    const bullets = (text.match(/^\s*[-•*]\s|^\s*\d+[.)]\s/gm) ?? []).length;
    if (bullets > 3) {
      return `BLOCKED: Status question got ${bullets} bullet points. Give the direct answer in 1-2 lines.`;
    }
  }

  return null;
}

// ── Haiku scope/completeness validator ───────────────────────────────

// Build the validator prompt via template literal — no .replace() placeholders,
// so user/assistant content containing marker-like strings cannot corrupt the prompt.
function buildHaikuPrompt(userMsg: string, assistantMsg: string): string {
  return `You are a strict response validator. Check the assistant response against the user request using this checklist.

User request:
${userMsg}

Assistant response:
${assistantMsg}

CHECKLIST — evaluate each independently:

1. SCOPE CREEP (did the assistant add things not asked for?)
- Adding variants, alternatives, or "related" items not requested
- Adding safety nets, extra options, or improvements not requested
- Answering the inverse of what was asked (listing what IS fine when asked what is WRONG)
- Mutating files when only asked to analyze/review/check
- Padding with recaps, summaries, or inventories to prove thoroughness
- When asked WHY: restating what was done wrong instead of diagnosing the actual cause
- Narrating completed actions the user asked not to be told about

2. COMPLETENESS (did the assistant address EVERYTHING asked?)
- Enumerate every distinct question, request, instruction, and action item in the user message
- Was each one answered or addressed in the response?
- If user listed multiple items (numbered, bulleted, or inline with "and"), were ALL covered?
- If user gave multiple instructions, were ALL followed?
- If user asked something to be done (create, fix, remove), was it executed, not just discussed?
- If user asked about a specific thing, did the response answer THAT thing (not substitute a different topic)?

Respond with ONLY one of:
PASS - both checks pass
FAIL SCOPE: <one sentence explaining what was added that was not requested>
FAIL COMPLETENESS: <list each specific question/request that was missed>
FAIL BOTH: <scope issue> AND <completeness issue>`;
}

type HaikuLogger = { warn?: (m: string) => void; error: (m: string) => void };

async function checkHaiku(params: {
  userMsg: string;
  assistantMsg: string;
  apiKey: string;
  logger: HaikuLogger;
}): Promise<string | null> {
  // Skip if combined text would exceed ~190K tokens (rough char estimate)
  if (params.userMsg.length + params.assistantMsg.length > 760_000) {
    params.logger.warn?.("response-validator: skipping Haiku (combined text too large)");
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    // Intentionally uses raw fetch to Anthropic API rather than runEmbeddedPiAgent:
    // the validator requires deterministic model selection (always Haiku, never affected
    // by config model overrides) and minimal latency. Auth IS resolved via the platform's
    // resolveApiKeyForProvider — only the model routing is bypassed by design.
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": params.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [
          { role: "user", content: buildHaikuPrompt(params.userMsg, params.assistantMsg) },
        ],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      params.logger.error(`response-validator: Haiku API ${resp.status}: ${errText}`);
      return `BLOCKED: Haiku validator API error (${resp.status}). Blocking until validator can run.`;
    }

    const data = (await resp.json()) as {
      content?: Array<{ text?: string }>;
      error?: { message?: string };
    };
    const verdict = data.content?.[0]?.text?.trim() ?? "";

    if (!verdict) {
      const apiErr = data.error?.message;
      params.logger.error(`response-validator: Haiku empty verdict${apiErr ? `: ${apiErr}` : ""}`);
      return "BLOCKED: Haiku validator returned empty response. Blocking until validator can run.";
    }

    if (verdict.startsWith("PASS")) {
      return null;
    }

    if (verdict.startsWith("FAIL")) {
      return `BLOCKED by response validator: ${verdict}\n\nDo EXACTLY what was asked — nothing more, nothing less.`;
    }

    // Malformed verdict (not PASS or FAIL) — fail-closed
    params.logger.error(`response-validator: Haiku malformed verdict: ${verdict.slice(0, 100)}`);
    return "BLOCKED: Haiku validator returned malformed verdict. Blocking until validator can run.";
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      params.logger.error("response-validator: Haiku timed out (120s)");
      return "BLOCKED: Haiku validator timed out. Blocking until validator can run.";
    }
    const msg = err instanceof Error ? err.message : String(err);
    params.logger.error(`response-validator: Haiku failed: ${msg}`);
    return "BLOCKED: Haiku validator error. Blocking until validator can run.";
  } finally {
    clearTimeout(timer);
  }
}

// ── Retry injection (deferred past delivery pipeline) ────────────────

function scheduleRetry(
  api: OpenClawPluginApi,
  session: { sessionKey: string; agentId: string } | undefined,
  reason: string,
): void {
  if (!session?.sessionKey) return;

  setTimeout(async () => {
    try {
      await api.runtime.subagent.run({
        sessionKey: session.sessionKey,
        message: `${reason}\n\nRESUBMIT YOUR ENTIRE RESPONSE from scratch — the blocked response is LOST (user never saw it).`,
      });
    } catch (err: unknown) {
      api.logger.error(
        `response-validator: retry injection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, 300);
}

// ── Plugin entry ─────────────────────────────────────────────────────

type PluginConfig = {
  enabled?: boolean;
  maxRetries?: number;
  agents?: Record<string, { enabled?: boolean }>;
};

export default definePluginEntry({
  id: "response-validator",
  name: "Response Validator",
  description: "Gates outbound agent replies with regex and Haiku validation",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;
    if (cfg.enabled === false) {
      api.logger.info?.("response-validator: disabled");
      return;
    }

    const maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
    const agentCfg = cfg.agents ?? {};

    // ── Hook: capture user's last message ─────────────────────────────
    api.on("message_received", (_event, ctx) => {
      prune(userMessages);
      const key = ctxKey(ctx);
      userMessages.set(key, {
        content: (_event as { content?: string }).content ?? "",
        ts: Date.now(),
      });
    });

    // ── Hook: capture session context for retry injection ─────────────
    // llm_output ctx is PluginHookAgentContext — has channelId but NOT accountId.
    // Key by channelId only; looked up the same way in message_sending.
    api.on("llm_output", (_event, ctx) => {
      const agentCtx = ctx as { sessionKey?: string; channelId?: string; agentId?: string };
      if (!agentCtx.sessionKey || !agentCtx.channelId) return;
      prune(sessionCtx);
      sessionCtx.set(agentCtx.channelId, {
        sessionKey: agentCtx.sessionKey,
        agentId: agentCtx.agentId ?? "main",
        ts: Date.now(),
      });
    });

    // ── Hook: primary validation gate ─────────────────────────────────
    api.on(
      "message_sending",
      async (event, ctx) => {
        const text: string = (event as { content?: string }).content ?? "";
        if (!text.trim()) return; // skip empty/media-only

        const key0 = ctxKey(ctx);
        // sessionCtx keyed by channelId only (llm_output has no accountId)
        const session = sessionCtx.get(ctx.channelId);

        // Per-agent disable
        if (session) {
          const agentOverride = agentCfg[session.agentId];
          if (agentOverride?.enabled === false) return;
        }

        // Retry cap
        const retryKey = key0;
        const existing = retryCounts.get(retryKey);
        const count = existing && Date.now() - existing.ts < TTL_MS ? existing.count : 0;
        if (count >= maxRetries) {
          api.logger.warn?.(
            `response-validator: retry cap (${maxRetries}) reached, allowing through`,
          );
          retryCounts.delete(retryKey);
          return;
        }

        // ── Regex checks ──────────────────────────────────────────────
        const userMsg = userMessages.get(key0)?.content;

        const regexBlock = checkRegex(text, userMsg);
        if (regexBlock) {
          api.logger.info?.(`response-validator: ${regexBlock.slice(0, 80)}`);
          retryCounts.set(retryKey, { count: count + 1, ts: Date.now() });
          scheduleRetry(api, session, regexBlock);
          return { cancel: true };
        }

        // ── Haiku check ───────────────────────────────────────────────
        if (!userMsg) {
          api.logger.warn?.("response-validator: no user message, skipping Haiku");
          return;
        }

        let apiKey: string | undefined;
        try {
          const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({
            provider: "anthropic",
          });
          apiKey = auth?.apiKey;
        } catch (authErr: unknown) {
          api.logger.warn?.(
            `response-validator: modelAuth failed (${authErr instanceof Error ? authErr.message : String(authErr)}), trying file fallback`,
          );
        }
        if (!apiKey) {
          try {
            // Fallback: Claude Code hook API key file (our setup)
            apiKey = (await readFile(`${process.env.HOME}/.claude/hooks/api_key`, "utf8")).trim();
          } catch (fsErr: unknown) {
            api.logger.warn?.(
              `response-validator: file fallback failed (${fsErr instanceof Error ? fsErr.message : String(fsErr)})`,
            );
          }
        }
        if (!apiKey) {
          api.logger.error("response-validator: no Anthropic API key, blocking");
          retryCounts.set(retryKey, { count: count + 1, ts: Date.now() });
          scheduleRetry(api, session, "BLOCKED: No API key for Haiku validator.");
          return { cancel: true };
        }

        const haikuBlock = await checkHaiku({
          userMsg,
          assistantMsg: text,
          apiKey,
          logger: api.logger,
        });

        if (haikuBlock) {
          api.logger.info?.(`response-validator: ${haikuBlock.slice(0, 80)}`);
          retryCounts.set(retryKey, { count: count + 1, ts: Date.now() });
          scheduleRetry(api, session, haikuBlock);
          return { cancel: true };
        }

        // All checks passed — clear any stale retry count for this key
        if (count > 0) {
          retryCounts.delete(retryKey);
        }
      },
      { priority: -100 }, // run after other hooks
    );
  },
});

import { rmSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelRef,
} from "../agents/model-selection.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedTtsConfig } from "./tts.js";

const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

type SummarizeTextDeps = {
  completeSimple: typeof completeSimple;
  getApiKeyForModel: typeof getApiKeyForModel;
  prepareModelForSimpleCompletion: typeof prepareModelForSimpleCompletion;
  requireApiKey: typeof requireApiKey;
  resolveModelAsync: typeof resolveModelAsync;
};

function resolveDefaultSummarizeTextDeps(): SummarizeTextDeps {
  return {
    completeSimple,
    getApiKeyForModel,
    prepareModelForSimpleCompletion,
    requireApiKey,
    resolveModelAsync,
  };
}

export function requireInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

export function normalizeLanguageCode(code?: string): string | undefined {
  const trimmed = code?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) {
    throw new Error("languageCode must be a 2-letter ISO 639-1 code (e.g. en, de, fr)");
  }
  return normalized;
}

export function normalizeApplyTextNormalization(mode?: string): "auto" | "on" | "off" | undefined {
  const trimmed = mode?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "auto" || normalized === "on" || normalized === "off") {
    return normalized;
  }
  throw new Error("applyTextNormalization must be one of: auto, on, off");
}

export function normalizeSeed(seed?: number): number | undefined {
  if (seed == null) {
    return undefined;
  }
  const next = Math.floor(seed);
  if (!Number.isFinite(next) || next < 0 || next > 4_294_967_295) {
    throw new Error("seed must be between 0 and 4294967295");
  }
  return next;
}

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

type SummaryModelSelection = {
  ref: ModelRef;
  source: "summaryModel" | "default";
};

function resolveSummaryModelRef(
  cfg: OpenClawConfig,
  config: ResolvedTtsConfig,
): SummaryModelSelection {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const override = config.summaryModel?.trim();
  if (!override) {
    return { ref: defaultRef, source: "default" };
  }

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultRef.provider });
  const resolved = resolveModelRefFromString({
    raw: override,
    defaultProvider: defaultRef.provider,
    aliasIndex,
  });
  if (!resolved) {
    return { ref: defaultRef, source: "default" };
  }
  return { ref: resolved.ref, source: "summaryModel" };
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

export async function summarizeText(
  params: {
    text: string;
    targetLength: number;
    cfg: OpenClawConfig;
    config: ResolvedTtsConfig;
    timeoutMs: number;
  },
  deps: SummarizeTextDeps = resolveDefaultSummarizeTextDeps(),
): Promise<SummarizeResult> {
  const { text, targetLength, cfg, config, timeoutMs } = params;
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const { ref } = resolveSummaryModelRef(cfg, config);
  const resolved = await deps.resolveModelAsync(ref.provider, ref.model, undefined, cfg);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown summary model: ${ref.provider}/${ref.model}`);
  }
  const completionModel = deps.prepareModelForSimpleCompletion({ model: resolved.model, cfg });
  const apiKey = deps.requireApiKey(
    await deps.getApiKeyForModel({ model: completionModel, cfg }),
    ref.provider,
  );

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await deps.completeSimple(
        completionModel,
        {
          messages: [
            {
              role: "user",
              content:
                `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
                `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
                `Reply only with the summary, without additional explanations.\n\n` +
                `<text_to_summarize>\n${text}\n</text_to_summarize>`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: Math.ceil(targetLength / 2),
          temperature: 0.3,
          signal: controller.signal,
        },
      );
      const summary = res.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!summary) {
        throw new Error("No summary returned");
      }

      return {
        summary,
        latencyMs: Date.now() - startTime,
        inputLength: text.length,
        outputLength: summary.length,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      throw new Error("Summarization timed out", { cause: err });
    }
    throw err;
  }
}

export function scheduleCleanup(
  tempDir: string,
  delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS,
): void {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }, delayMs);
  timer.unref();
}

// ---------------------------------------------------------------------------
// OpenAI TTS streaming helpers
// The functions below (normalizeOpenAITtsBaseUrl, getOpenAITtsBaseUrl, etc.)
// were extracted from this file into extensions/openai/tts.ts when TTS
// providers were pluginized. They are duplicated here to keep openaiTTSStream
// self-contained within core — core cannot import from extensions.
// ---------------------------------------------------------------------------

const OPENAI_TTS_DEFAULT_BASE_URL = "https://api.openai.com/v1";

const OPENAI_TTS_MODELS_LIST = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;

const OPENAI_TTS_VOICES_LIST = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "juniper",
  "marin",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

function normalizeOpenAITtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return OPENAI_TTS_DEFAULT_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function isCustomOpenAIEndpoint(baseUrl?: string): boolean {
  if (baseUrl != null) {
    return normalizeOpenAITtsBaseUrl(baseUrl) !== OPENAI_TTS_DEFAULT_BASE_URL;
  }
  return normalizeOpenAITtsBaseUrl(process.env.OPENAI_TTS_BASE_URL) !== OPENAI_TTS_DEFAULT_BASE_URL;
}

function getOpenAITtsBaseUrl(): string {
  return normalizeOpenAITtsBaseUrl(
    process.env.OPENAI_TTS_BASE_URL?.trim() || OPENAI_TTS_DEFAULT_BASE_URL,
  );
}

function isValidOpenAITtsStreamModel(model: string, baseUrl?: string): boolean {
  if (isCustomOpenAIEndpoint(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_MODELS_LIST.includes(model as (typeof OPENAI_TTS_MODELS_LIST)[number]);
}

function isValidOpenAITtsStreamVoice(voice: string, baseUrl?: string): boolean {
  if (isCustomOpenAIEndpoint(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_VOICES_LIST.includes(voice as (typeof OPENAI_TTS_VOICES_LIST)[number]);
}

function resolveOpenAITtsStreamInstructions(
  model: string,
  instructions?: string,
): string | undefined {
  const next = instructions?.trim();
  return next && model.includes("gpt-4o-mini-tts") ? next : undefined;
}

export type OpenaiTTSStreamResult = {
  stream: Readable;
  cleanup: () => void;
};

/**
 * Streaming variant of openaiTTS. Returns a Node.js Readable stream of raw PCM/mp3/opus
 * bytes instead of buffering the entire response into a Buffer.
 *
 * Unlike openaiTTS (which requires baseUrl), baseUrl is optional here and
 * falls back to the OPENAI_TTS_BASE_URL env var then the OpenAI default.
 * This lets callers like textToSpeechTelephonyStream pass the resolved config
 * value while tests and direct consumers can rely on the env-var fallback.
 */
export async function openaiTTSStream(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  voice: string;
  speed?: number;
  instructions?: string;
  responseFormat: "mp3" | "opus" | "pcm";
  timeoutMs: number;
}): Promise<OpenaiTTSStreamResult> {
  const { text, apiKey, model, voice, speed, responseFormat, timeoutMs } = params;
  const effectiveBaseUrl = params.baseUrl?.trim()
    ? normalizeOpenAITtsBaseUrl(params.baseUrl)
    : getOpenAITtsBaseUrl();
  const effectiveInstructions = resolveOpenAITtsStreamInstructions(model, params.instructions);

  if (!isValidOpenAITtsStreamModel(model, effectiveBaseUrl)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAITtsStreamVoice(voice, effectiveBaseUrl)) {
    throw new Error(`Invalid voice: ${voice}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    clearTimeout(timeout);
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
    }
    controller.abort();
  };

  const response = await fetch(`${effectiveBaseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: responseFormat,
      ...(speed != null && { speed }),
      ...(effectiveInstructions != null && { instructions: effectiveInstructions }),
    }),
    signal: controller.signal,
  }).catch((err) => {
    cleanup();
    throw err;
  });

  if (!response.ok) {
    cleanup();
    throw new Error(`OpenAI TTS API error (${response.status})`);
  }

  if (!response.body) {
    cleanup();
    throw new Error("OpenAI TTS API returned no body");
  }

  // Clear the connection timeout now that headers have arrived.
  // Install a read-deadline watchdog: if no data arrives, abort to prevent
  // a stalled stream from hanging the TTS pipeline indefinitely.
  // Use the configured timeout (capped at 30s) so operators with shorter
  // timeouts get faster failure on mid-stream stalls.
  clearTimeout(timeout);
  const STALL_DEADLINE_MS = Math.min(timeoutMs, 30_000);
  stallTimer = setTimeout(
    () => controller.abort(new Error("TTS stream stall timeout")),
    STALL_DEADLINE_MS,
  ).unref();

  // Double cast required: fetch Response.body is a web ReadableStream but
  // Readable.fromWeb expects the Node.js stream/web type. Standard pattern
  // used across the codebase (batch-voyage.ts, acp/server.ts, etc.).
  const stream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );

  // Wrap in a Transform with zero readable highWaterMark so backpressure
  // gates transform() calls to downstream consumption speed. This ensures
  // the stall watchdog resets on *consumption*, not on arrival — without it,
  // fast OpenAI delivery would buffer all chunks (resetting the timer on
  // each), then the timer starts its final countdown while the caller still
  // drains at ~real-time (20 ms/frame).
  const watchdogTransform = new Transform({
    readableHighWaterMark: 0,
    transform(chunk, _encoding, callback) {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => controller.abort(new Error("TTS stream stall timeout")),
        STALL_DEADLINE_MS,
      ).unref();
      callback(null, chunk);
    },
  });
  stream.pipe(watchdogTransform);
  stream.on("error", (err) => watchdogTransform.destroy(err));
  watchdogTransform.on("end", cleanup);
  watchdogTransform.on("error", cleanup);
  watchdogTransform.on("close", cleanup);

  return { stream: watchdogTransform, cleanup };
}

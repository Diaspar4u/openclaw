import type { Readable } from "node:stream";
import * as speechRuntime from "../../extensions/speech-core/runtime-api.js";
import { openaiTTSStream } from "./tts-core.js";

export const buildTtsSystemPromptHint = speechRuntime.buildTtsSystemPromptHint;
export const getLastTtsAttempt = speechRuntime.getLastTtsAttempt;
export const getResolvedSpeechProviderConfig = speechRuntime.getResolvedSpeechProviderConfig;
export const getTtsMaxLength = speechRuntime.getTtsMaxLength;
export const getTtsProvider = speechRuntime.getTtsProvider;
export const isSummarizationEnabled = speechRuntime.isSummarizationEnabled;
export const isTtsEnabled = speechRuntime.isTtsEnabled;
export const isTtsProviderConfigured = speechRuntime.isTtsProviderConfigured;
export const listSpeechVoices = speechRuntime.listSpeechVoices;
export const maybeApplyTtsToPayload = speechRuntime.maybeApplyTtsToPayload;
export const resolveTtsAutoMode = speechRuntime.resolveTtsAutoMode;
export const resolveTtsConfig = speechRuntime.resolveTtsConfig;
export const resolveTtsPrefsPath = speechRuntime.resolveTtsPrefsPath;
export const resolveTtsProviderOrder = speechRuntime.resolveTtsProviderOrder;
export const setLastTtsAttempt = speechRuntime.setLastTtsAttempt;
export const setSummarizationEnabled = speechRuntime.setSummarizationEnabled;
export const setTtsAutoMode = speechRuntime.setTtsAutoMode;
export const setTtsEnabled = speechRuntime.setTtsEnabled;
export const setTtsMaxLength = speechRuntime.setTtsMaxLength;
export const setTtsProvider = speechRuntime.setTtsProvider;
export const synthesizeSpeech = speechRuntime.synthesizeSpeech;
export const textToSpeech = speechRuntime.textToSpeech;
export const textToSpeechTelephony = speechRuntime.textToSpeechTelephony;
export const _test = speechRuntime._test;

export type {
  ResolvedTtsConfig,
  ResolvedTtsModelOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
  TtsResult,
  TtsSynthesisResult,
  TtsTelephonyResult,
} from "../plugin-sdk/speech-runtime.js";

const TELEPHONY_OUTPUT = {
  openai: { format: "pcm" as const, sampleRate: 24000 },
};

export type TtsTelephonyStreamResult = {
  success: boolean;
  stream?: Readable;
  sampleRate?: number;
  provider?: string;
  error?: string;
  cleanup?: () => void;
};

/**
 * Streaming variant of textToSpeechTelephony.
 * Returns a Readable stream of raw PCM audio instead of a buffered Buffer.
 * Only supports OpenAI providers (ElevenLabs/Edge TTS skip for now).
 */
export async function textToSpeechTelephonyStream(params: {
  text: string;
  cfg: Parameters<typeof speechRuntime.resolveTtsConfig>[0];
  prefsPath?: string;
}): Promise<TtsTelephonyStreamResult> {
  const config = speechRuntime.resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? speechRuntime.resolveTtsPrefsPath(config);
  if (params.text.length > config.maxTextLength) {
    return {
      success: false,
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = speechRuntime.getTtsProvider(config, prefsPath);
  const providers = speechRuntime.resolveTtsProviderOrder(userProvider, params.cfg);

  const errors: string[] = [];

  // Streaming only supported for OpenAI — if user's primary provider isn't OpenAI,
  // return failure immediately so the caller falls back to the buffered path
  // with the correct voice/provider rather than silently switching to OpenAI.
  if (providers[0] !== "openai") {
    return {
      success: false,
      error: `Primary provider ${providers[0]} does not support streaming`,
    };
  }

  for (const provider of providers) {
    try {
      if (provider !== "openai") {
        continue;
      }

      const providerConfig = speechRuntime.getResolvedSpeechProviderConfig(
        config,
        provider,
        params.cfg,
      );
      const apiKey =
        (typeof providerConfig.apiKey === "string" && providerConfig.apiKey.trim()
          ? providerConfig.apiKey.trim()
          : undefined) ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        errors.push(`${provider}: no API key`);
        continue;
      }
      const baseUrl =
        typeof providerConfig.baseUrl === "string" && providerConfig.baseUrl.trim()
          ? providerConfig.baseUrl.trim()
          : undefined;
      const model =
        typeof providerConfig.model === "string" && providerConfig.model.trim()
          ? providerConfig.model.trim()
          : "gpt-4o-mini-tts";
      const voice =
        typeof providerConfig.voice === "string" && providerConfig.voice.trim()
          ? providerConfig.voice.trim()
          : "coral";
      const speed = typeof providerConfig.speed === "number" ? providerConfig.speed : undefined;
      const instructions =
        typeof providerConfig.instructions === "string" && providerConfig.instructions.trim()
          ? providerConfig.instructions.trim()
          : undefined;

      const output = TELEPHONY_OUTPUT.openai;
      const result = await openaiTTSStream({
        text: params.text,
        apiKey,
        baseUrl,
        model,
        voice,
        speed,
        instructions,
        responseFormat: output.format,
        timeoutMs: config.timeoutMs,
      });

      return {
        success: true,
        stream: result.stream,
        sampleRate: output.sampleRate,
        provider,
        cleanup: result.cleanup,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name === "AbortError") {
        errors.push(`${provider}: request timed out`);
      } else {
        errors.push(`${provider}: ${error.message}`);
      }
      // Permanent failures (invalid config, model validation) should not
      // fall through to the next provider — only transient I/O errors should.
      const isTransient =
        (err instanceof Error && /ECONNRESET|ETIMEDOUT|ENOTFOUND|AbortError/.test(err.name)) ||
        (err instanceof Error && /ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(err.message));
      if (!isTransient) {
        break;
      }
    }
  }

  return {
    success: false,
    error: `TTS streaming failed: ${errors.join("; ") || "no providers available"}`,
  };
}

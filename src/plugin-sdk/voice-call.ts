// Private helper surface for the bundled voice-call plugin.
// Keep this surface narrow and limited to the voice-call feature contract.

export { definePluginEntry } from "./core.js";
export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "../config/zod-schema.core.js";
export { resolveOpenAITtsInstructions } from "../tts/tts-core.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export type { SessionEntry } from "../config/sessions/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { callGateway } from "../gateway/call.js";
export type { CallGatewayOptions } from "../gateway/call.js";
export { sleep } from "../utils.js";
export { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

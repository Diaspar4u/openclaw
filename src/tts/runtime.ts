// Shared runtime-facing speech helpers. Keep channel/feature plugins on this
// boundary instead of importing the full TTS orchestrator module directly.

export {
  listSpeechVoices,
  textToSpeech,
  textToSpeechTelephony,
  textToSpeechTelephonyStream,
} from "./tts.js";
export type { TtsTelephonyStreamResult } from "./tts.js";

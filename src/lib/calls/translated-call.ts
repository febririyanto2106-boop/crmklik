/**
 * Shared vocabulary for the translated voice call feature.
 *
 * A call is one agent (inside the inbox) and one guest (a contact who opened
 * the public /call/$roomId link in any browser). Audio flows peer-to-peer
 * over WebRTC; Supabase Realtime broadcast is only the signalling rail
 * (SDP/ICE exchange, hangup, live captions). Nothing is persisted — a room
 * id is a random UUID that exists only while both tabs are open.
 *
 * All Azure Speech usage happens on the agent's side (it is the
 * authenticated one): the agent's mic and the guest's incoming audio are
 * both recognized + translated there, and the guest merely receives caption
 * text over the broadcast channel. The guest page therefore needs no Azure
 * token at all, which keeps the public page abuse-proof.
 */

export const CALL_CHANNEL_PREFIX = "trcall:";

/** Everything that travels over the signalling channel. */
export type CallSignal =
  | { kind: "join" } // guest is on the page and ready
  | { kind: "offer"; sdp: string; video?: boolean }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "hangup"; by: "agent" | "guest" }
  // Consent notice: the agent started/stopped recording the call.
  | { kind: "recording"; on: boolean }
  | {
      kind: "caption";
      /** Who spoke. */
      who: "agent" | "guest";
      /** What they said, in the speaker's own language. */
      original: string;
      /** The same utterance in the listener's language. */
      translated: string;
      /** False while the recognizer is still revising this phrase. */
      final: boolean;
      /** Identity of the phrase, so partials replace instead of append. */
      id: string;
      /** Translation target code of `translated` (e.g. "en"), for guest TTS. */
      lang: string;
    };

export type CaptionEntry = {
  id: string;
  who: "agent" | "guest";
  original: string;
  translated: string;
  final: boolean;
};

/**
 * Languages offered in the call UI. `locale` feeds Azure speech recognition;
 * `target` is the matching text-translation target code.
 */
export const CALL_LANGUAGES: { locale: string; target: string; label: string }[] = [
  { locale: "bn-IN", target: "bn", label: "বাংলা (Bengali)" },
  { locale: "hi-IN", target: "hi", label: "हिन्दी (Hindi)" },
  { locale: "en-US", target: "en", label: "English" },
  { locale: "ar-SA", target: "ar", label: "العربية (Arabic)" },
  { locale: "he-IL", target: "he", label: "עברית (Hebrew)" },
  { locale: "es-ES", target: "es", label: "Español (Spanish)" },
  { locale: "de-DE", target: "de", label: "Deutsch (German)" },
  { locale: "fr-FR", target: "fr", label: "Français (French)" },
  { locale: "pt-BR", target: "pt", label: "Português (Portuguese)" },
  { locale: "id-ID", target: "id", label: "Bahasa Indonesia" },
];

export function callLanguage(locale: string) {
  return CALL_LANGUAGES.find((l) => l.locale === locale) ?? CALL_LANGUAGES[2]!;
}

/**
 * Azure neural voice per translation target, for speech-to-speech dubbing.
 * One pleasant default voice per language; the browser-TTS fallback below
 * covers synthesis failures.
 */
export const NEURAL_VOICE_BY_TARGET: Record<string, string> = {
  bn: "bn-IN-TanishaaNeural",
  hi: "hi-IN-SwaraNeural",
  en: "en-US-JennyNeural",
  ar: "ar-SA-ZariyahNeural",
  he: "he-IL-HilaNeural",
  es: "es-ES-ElviraNeural",
  de: "de-DE-KatjaNeural",
  fr: "fr-FR-DeniseNeural",
  pt: "pt-BR-FranciscaNeural",
  id: "id-ID-GadisNeural",
};

/**
 * Tiny protocol for shipping synthesized MP3 phrases over the WebRTC data
 * channel (agent → guest): a text frame "TTS:<byteLength>" announces a
 * phrase, then binary frames follow until that many bytes have arrived.
 */
export const TTS_CHANNEL_LABEL = "tts";
export const TTS_HEADER_PREFIX = "TTS:";
export const TTS_CHUNK_BYTES = 16_000;

/** STUN-only fallback, used when TURN credentials cannot be fetched. */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};

/**
 * The real ICE config for a call: STUN plus Cloudflare TURN relay
 * credentials when the server has them configured. Never throws — a failed
 * fetch degrades to STUN-only (exactly the pre-TURN behaviour).
 */
export async function fetchRtcConfig(): Promise<RTCConfiguration> {
  try {
    const { getCallIceServers } = await import("@/lib/calls/turn.functions");
    const { iceServers } = await getCallIceServers();
    return iceServers?.length ? { iceServers } : RTC_CONFIG;
  } catch {
    return RTC_CONFIG;
  }
}

/** How long a sent call link stays joinable. */
export const CALL_LINK_TTL_MS = 60 * 60 * 1000;

export function callRoomUrl(roomId: string, expiresAt?: number) {
  const base = `${window.location.origin}/call/${roomId}`;
  // The guest page reads `exp` to refuse stale links with a clear message
  // instead of an endless "waiting" spinner. It is advisory, not security:
  // the room id itself is the credential.
  return expiresAt ? `${base}?exp=${expiresAt}` : base;
}

/**
 * Speech-to-speech: speak a finalized translated phrase aloud through the
 * browser's own speech synthesis. Free, offline-capable and available on
 * both the agent's and the guest's side without shipping any credentials —
 * which is why phase 2 starts here rather than with server-side TTS.
 * `targetLang` is a translation target code like "bn" or "en".
 */
export function speakTranslated(text: string, targetLang: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text.trim()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const voice =
    voices.find((v) => v.lang.toLowerCase().startsWith(`${targetLang}-`)) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(targetLang));
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang ?? targetLang;
  utterance.rate = 1.05; // slightly brisk so the dub keeps up with the call
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

/**
 * Picks the MIME type for a dubbed-audio buffer by sniffing its container.
 *
 * Two sources feed the same playback queue and they do not agree on format:
 * the classic path asks SpeechSynthesizer for MP3, while Live Interpreter's
 * `synthesizing` event returns whatever the service sends (RIFF/WAV in
 * practice; Azure does not document it). Labelling a WAV buffer as audio/mpeg
 * makes playback fail silently, so the bytes decide rather than the caller.
 */
export function sniffAudioMime(buffer: ArrayBuffer): string {
  const b = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
  // "RIFF" .... "WAVE"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "audio/wav";
  // "OggS"
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg";
  // "ID3" tag, or an MPEG frame sync (0xFF 0xEx/0xFx)
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  // Unknown: MP3 is what the classic path has always produced.
  return "audio/mpeg";
}

/**
 * Speech-to-text into a text field via Azure AI Speech's real-time
 * continuous recognition — genuine streaming (interim results that can
 * revise as the engine firms up its guess, finalized phrases as they land),
 * not a simulation built out of short batch-transcribed clips.
 *
 * Shared by the composer's dictation mic and the AI reply assistant's
 * "Custom instruction" dictation button — both reduce to the same shape:
 * a string value to append to, and a setter for the result.
 *
 * The Speech SDK only ever runs in the browser (it needs the microphone),
 * loaded via a dynamic import so it never touches the SSR bundle. The
 * server only ever hands back a short-lived token (see
 * `azure-speech-token.functions.ts`) — the real subscription key never
 * reaches the browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getAzureSpeechToken } from "@/lib/ai/azure-speech-token.functions";
// Type-only: erased at compile time, so this never forces the SDK itself
// (which the browser-only `import()` below loads) into the SSR bundle.
import type {
  Recognizer,
  SpeechRecognitionCanceledEventArgs,
  SpeechRecognitionEventArgs,
  SpeechRecognizer,
} from "microsoft-cognitiveservices-speech-sdk";

/**
 * Azure's continuous language identification accepts up to 10 locales, one
 * per base language. These three cover this workspace's actual usage.
 */
// Azure's continuous language identification accepts at most 10 candidate
// locales — speech in a language outside this list won't transcribe
// correctly, so these ten are chosen for this product's actual audience.
// Note: Bengali must be bn-IN; Azure's language ID rejects bn-BD outright
// ("Language Identification doesn't support bn-bd").
const RECOGNITION_LANGUAGES = [
  "bn-IN", // Bengali
  "hi-IN", // Hindi
  "en-US", // English
  "ar-SA", // Arabic
  "he-IL", // Hebrew
  "es-ES", // Spanish
  "de-DE", // German
  "fr-FR", // French
  "pt-BR", // Portuguese
  "id-ID", // Indonesian
];

/**
 * One live microphone at a time, app-wide. Every mic feature (both dictation
 * buttons, the composer's voice-note recorder) claims the mic when it starts;
 * claiming it stops whoever held it before, so two recordings can never run
 * over each other. The `release` function doubles as the holder's identity,
 * so it must be referentially stable for the holder's lifetime.
 */
let releaseActiveMic: (() => void) | null = null;

export function claimMicrophone(release: () => void) {
  if (releaseActiveMic && releaseActiveMic !== release) releaseActiveMic();
  releaseActiveMic = release;
}

export function releaseMicrophone(release: () => void) {
  if (releaseActiveMic === release) releaseActiveMic = null;
}

type StopReason = "user" | "cancel" | "unmount";

export function useAzureDictation(opts: {
  /** The field's current text, captured once when dictation starts. */
  value: string;
  /** Called with the full resulting text (base + transcript) — replace, not append. */
  onChange: (text: string) => void;
  /** An error worth surfacing to the user (toast, etc). */
  onError?: (message: string) => void;
  /** The session ended with nothing recognized. */
  onNoSpeech?: () => void;
}) {
  const { value, onChange, onError, onNoSpeech } = opts;
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Callers pass these as inline arrows, so they change identity every
  // render. Routing them through refs keeps `stop`/`start` stable — if
  // `stop` were recreated per render, the unmount-cleanup effect below
  // would re-run on every render and silently kill an in-flight session.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onNoSpeechRef = useRef(onNoSpeech);
  onNoSpeechRef.current = onNoSpeech;

  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const baseRef = useRef(""); // text already in the field before dictation started
  const committedRef = useRef(""); // finalized phrases so far this session
  const valueRef = useRef(value);
  valueRef.current = value;
  // Bumped on every start/stop so a `start()` still mid-flight (token fetch,
  // recognizer startup) can tell it was superseded by a stop clicked in that
  // gap, and back out instead of beginning to listen anyway.
  const sessionRef = useRef(0);

  const render = useCallback((tail: string) => {
    const committed = committedRef.current;
    const combinedTail = committed ? (tail ? `${committed} ${tail}` : committed) : tail;
    const base = baseRef.current;
    onChangeRef.current(
      base ? (combinedTail ? `${base.replace(/\s+$/, "")} ${combinedTail}` : base) : combinedTail,
    );
  }, []);

  // Stable identity for the one-mic-at-a-time registry above.
  const releaseSelfRef = useRef<(() => void) | null>(null);

  const stop = useCallback((reason: StopReason) => {
    if (releaseSelfRef.current) releaseMicrophone(releaseSelfRef.current);
    sessionRef.current++;
    const rec = recognizerRef.current;
    recognizerRef.current = null;
    setActive(false);
    setConnecting(false);
    if (reason === "user" && !committedRef.current) onNoSpeechRef.current?.();
    if (!rec) return;
    try {
      rec.stopContinuousRecognitionAsync(
        () => rec.close(),
        () => rec.close(),
      );
    } catch {
      /* already gone */
    }
  }, []);

  if (!releaseSelfRef.current) releaseSelfRef.current = () => stop("cancel");

  // Never leave the microphone live when the UI around it goes away.
  useEffect(() => () => stop("unmount"), [stop]);

  const start = useCallback(async () => {
    const mySession = ++sessionRef.current;
    const stillCurrent = () => sessionRef.current === mySession;

    // Stops any other live mic (the other dictation button, or a voice-note
    // recording) before this one begins.
    claimMicrophone(releaseSelfRef.current!);

    baseRef.current = valueRef.current;
    committedRef.current = "";
    setConnecting(true);
    try {
      const sdk = await import("microsoft-cognitiveservices-speech-sdk");
      if (!stillCurrent()) return; // stopped while the SDK was loading

      const { token, region } = await getAzureSpeechToken({ data: {} });
      if (!stillCurrent()) return; // stopped while the token was in flight

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token, region);
      const autoDetectConfig =
        sdk.AutoDetectSourceLanguageConfig.fromLanguages(RECOGNITION_LANGUAGES);
      autoDetectConfig.mode = sdk.LanguageIdMode.Continuous;
      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      const recognizer = sdk.SpeechRecognizer.FromConfig(
        speechConfig,
        autoDetectConfig,
        audioConfig,
      );

      recognizer.recognizing = (_s: Recognizer, e: SpeechRecognitionEventArgs) => {
        if (e.result.reason === sdk.ResultReason.RecognizingSpeech) render(e.result.text);
      };
      recognizer.recognized = (_s: Recognizer, e: SpeechRecognitionEventArgs) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
          committedRef.current = committedRef.current
            ? `${committedRef.current} ${e.result.text}`
            : e.result.text;
          render("");
        }
      };
      recognizer.canceled = (_s: Recognizer, e: SpeechRecognitionCanceledEventArgs) => {
        if (e.reason === sdk.CancellationReason.Error) {
          onErrorRef.current?.(e.errorDetails || "Dictation stopped unexpectedly.");
        }
        stop("cancel");
      };

      if (!stillCurrent()) return; // stopped before the recognizer could even be registered
      recognizerRef.current = recognizer;
      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, (e: string) => reject(new Error(e)));
      });
      if (!stillCurrent()) {
        // Stopped while the connection was coming up — this session's own
        // `stop()` never got a recognizer to close (it wasn't registered
        // yet), so this one closes it now and clears the ref only if a
        // newer session hasn't already claimed it.
        if (recognizerRef.current === recognizer) recognizerRef.current = null;
        try {
          recognizer.stopContinuousRecognitionAsync(
            () => recognizer.close(),
            () => recognizer.close(),
          );
        } catch {
          /* already gone */
        }
        return;
      }
      setConnecting(false);
      setActive(true);
    } catch (e) {
      if (!stillCurrent()) return; // already torn down by a stop() in the meantime
      setConnecting(false);
      setActive(false);
      recognizerRef.current = null;
      const raw = e instanceof Error ? e.message : "Could not start dictation.";
      const message = /permission|notallowed|denied/i.test(raw)
        ? "Microphone access denied. Allow microphone access for this site, then try again."
        : raw;
      onErrorRef.current?.(message);
    }
  }, [render, stop]);

  const toggle = useCallback(() => {
    if (active || connecting) stop("user");
    else void start();
  }, [active, connecting, start, stop]);

  return { active, connecting, toggle };
}

/**
 * Agent side of a translated voice call.
 *
 * Owns the whole call lifecycle: the Supabase Realtime signalling channel,
 * the WebRTC peer connection to the guest, and the two Azure translation
 * recognizers (one on the agent's mic, one on the guest's incoming audio).
 * See `@/lib/calls/translated-call.ts` for the architecture note.
 *
 * The guest page (src/routes/call.$roomId.tsx) is the other half: it only
 * answers the WebRTC offer and renders captions this hook broadcasts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type {
  TranslationRecognizer,
  TranslationRecognitionEventArgs,
  TranslationRecognitionCanceledEventArgs,
  Recognizer,
  SpeechSynthesizer,
} from "microsoft-cognitiveservices-speech-sdk";
import { supabase } from "@/integrations/supabase/client";
import { getAzureSpeechToken } from "@/lib/ai/azure-speech-token.functions";
import { claimMicrophone, releaseMicrophone } from "@/hooks/use-azure-dictation";
import {
  CALL_CHANNEL_PREFIX,
  NEURAL_VOICE_BY_TARGET,
  RTC_CONFIG,
  fetchRtcConfig,
  TTS_CHANNEL_LABEL,
  TTS_CHUNK_BYTES,
  TTS_HEADER_PREFIX,
  callLanguage,
  speakTranslated,
  stopSpeaking,
  type CallSignal,
  type CaptionEntry,
  sniffAudioMime,
} from "@/lib/calls/translated-call";

export type CallStatus =
  | "idle" // dialog open, call not started
  | "waiting" // we are live on the channel, guest hasn't joined yet
  | "connecting" // guest joined, WebRTC handshake in flight
  | "live" // two-way audio established
  | "ended";

type Sdk = typeof import("microsoft-cognitiveservices-speech-sdk");

export function useTranslatedCall(opts: {
  roomId: string;
  /** Azure locale the agent speaks, e.g. "bn-IN". */
  agentLocale: string;
  /** Azure locale the guest speaks, e.g. "en-US". */
  guestLocale: string;
  /** Capture and send camera video as well as audio. Fixed at start. */
  video?: boolean;
  onError?: (message: string) => void;
}) {
  const { roomId, agentLocale, guestLocale, video = false, onError } = opts;
  const [status, setStatus] = useState<CallStatus>("idle");
  const [captions, setCaptions] = useState<CaptionEntry[]>([]);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  // Speech-to-speech: speak the guest's finalized phrases aloud in the
  // agent's language (browser TTS). On by default; the captions stay either way.
  const [voiceOn, setVoiceOn] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Locales are locked in when the call starts; changing them mid-call would
  // need new recognizers, which phase 1 keeps out of scope.
  const agentLocaleRef = useRef(agentLocale);
  agentLocaleRef.current = agentLocale;
  const guestLocaleRef = useRef(guestLocale);
  guestLocaleRef.current = guestLocale;

  const channelRef = useRef<RealtimeChannel | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recognizersRef = useRef<TranslationRecognizer[]>([]);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);
  // The guest's incoming audio, kept so recognizers can be rebuilt mid-call.
  const remoteAudioStreamRef = useRef<MediaStream | null>(null);
  const offerSentRef = useRef(false);
  const sessionRef = useRef(0);
  // ICE config for this call: STUN + Cloudflare TURN when configured.
  const rtcConfigRef = useRef<RTCConfiguration>(RTC_CONFIG);
  // Azure tokens live ~10 minutes; long calls renew on this timer.
  const tokenRenewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<CallStatus>("idle");
  statusRef.current = status;

  const releaseSelfRef = useRef<(() => void) | null>(null);
  const videoRef = useRef(video);
  videoRef.current = video;
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  // --- Speech-to-speech (Azure neural TTS) ---------------------------------
  // One synthesizer per target language, created lazily once the call has an
  // SDK + token. The agent's phrases are synthesized in the guest's language
  // and shipped as MP3 over a WebRTC data channel; the guest's phrases are
  // synthesized in the agent's language and played locally through a small
  // sequential queue (so phrases never talk over each other).
  const sdkCtxRef = useRef<{
    sdk: Sdk;
    token: string;
    region: string;
    endpoint: string;
    liveInterpreter: boolean;
  } | null>(null);
  const synthsRef = useRef<Map<string, SpeechSynthesizer>>(new Map());
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const playQueueRef = useRef<{ urls: string[]; playing: boolean; audio: HTMLAudioElement | null }>(
    { urls: [], playing: false, audio: null },
  );

  const stopLocalDub = useCallback(() => {
    const q = playQueueRef.current;
    q.urls.forEach((u) => URL.revokeObjectURL(u));
    q.urls = [];
    q.playing = false;
    if (q.audio) {
      q.audio.pause();
      q.audio = null;
    }
  }, []);

  const enqueueDub = useCallback((audioData: ArrayBuffer) => {
    const q = playQueueRef.current;
    q.urls.push(URL.createObjectURL(new Blob([audioData], { type: sniffAudioMime(audioData) })));
    if (q.playing) return;
    const playNext = () => {
      const url = q.urls.shift();
      if (!url) {
        q.playing = false;
        q.audio = null;
        return;
      }
      q.playing = true;
      const audio = new Audio(url);
      q.audio = audio;
      audio.onended = audio.onerror = () => {
        URL.revokeObjectURL(url);
        playNext();
      };
      void audio.play().catch(() => {
        URL.revokeObjectURL(url);
        playNext();
      });
    };
    playNext();
  }, []);

  const ensureSynth = useCallback((target: string): SpeechSynthesizer | null => {
    const ctx = sdkCtxRef.current;
    const voice = NEURAL_VOICE_BY_TARGET[target];
    if (!ctx || !voice) return null;
    let synth = synthsRef.current.get(target);
    if (synth) return synth;
    const cfg = ctx.sdk.SpeechConfig.fromAuthorizationToken(ctx.token, ctx.region);
    cfg.speechSynthesisVoiceName = voice;
    cfg.speechSynthesisOutputFormat =
      ctx.sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
    // null audio config: we want the bytes, not immediate speaker playback.
    synth = new ctx.sdk.SpeechSynthesizer(cfg, null as never);
    synthsRef.current.set(target, synth);
    return synth;
  }, []);

  const synthesize = useCallback(
    (text: string, target: string): Promise<ArrayBuffer | null> =>
      new Promise((resolve) => {
        const synth = ensureSynth(target);
        if (!synth) return resolve(null);
        synth.speakTextAsync(
          text,
          (result) => resolve(result.audioData?.byteLength ? result.audioData : null),
          () => resolve(null),
        );
      }),
    [ensureSynth],
  );

  /** The guest spoke: say it in the agent's language, here. */
  const dubForAgent = useCallback(
    async (text: string, target: string) => {
      const audio = await synthesize(text, target);
      if (!voiceOnRef.current) return; // toggled off while synthesizing
      if (audio) enqueueDub(audio);
      else speakTranslated(text, target); // browser-TTS fallback
    },
    [synthesize, enqueueDub],
  );

  /**
   * Ships one dubbed-audio buffer to the guest over the data channel, as a
   * length header followed by chunks. Shared by both paths: the classic one
   * synthesizes first, Live Interpreter hands the bytes straight over.
   */
  const sendDubToGuest = useCallback((audio: ArrayBuffer) => {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== "open" || !audio.byteLength) return;
    try {
      dc.send(`${TTS_HEADER_PREFIX}${audio.byteLength}`);
      for (let i = 0; i < audio.byteLength; i += TTS_CHUNK_BYTES) {
        dc.send(audio.slice(i, i + TTS_CHUNK_BYTES));
      }
    } catch {
      /* channel closed mid-send — the captions still carry the words */
    }
  }, []);

  /** The agent spoke: synthesize in the guest's language, ship it over. */
  const dubForGuest = useCallback(
    async (text: string, target: string) => {
      const dc = dataChannelRef.current;
      if (!dc || dc.readyState !== "open") return;
      const audio = await synthesize(text, target);
      if (audio) sendDubToGuest(audio);
    },
    [synthesize, sendDubToGuest],
  );

  const sendSignal = useCallback((signal: CallSignal) => {
    void channelRef.current?.send({ type: "broadcast", event: "signal", payload: signal });
  }, []);

  const upsertCaption = useCallback((entry: CaptionEntry) => {
    setCaptions((prev) => {
      const i = prev.findIndex((c) => c.id === entry.id);
      if (i === -1) return [...prev.slice(-80), entry]; // keep the list bounded
      const next = prev.slice();
      next[i] = entry;
      return next;
    });
  }, []);

  /** Tear everything down. `notify` also tells the guest the call ended. */
  const hangup = useCallback(
    (notify: boolean) => {
      sessionRef.current++;
      if (releaseSelfRef.current) releaseMicrophone(releaseSelfRef.current);
      if (notify && statusRef.current !== "idle" && statusRef.current !== "ended") {
        void channelRef.current?.send({
          type: "broadcast",
          event: "signal",
          payload: { kind: "hangup", by: "agent" } satisfies CallSignal,
        });
      }
      for (const rec of recognizersRef.current) {
        try {
          rec.stopContinuousRecognitionAsync(
            () => rec.close(),
            () => rec.close(),
          );
        } catch {
          /* already gone */
        }
      }
      recognizersRef.current = [];
      peerRef.current?.close();
      peerRef.current = null;
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      if (remoteAudioElRef.current) {
        remoteAudioElRef.current.srcObject = null;
        remoteAudioElRef.current = null;
      }
      remoteAudioStreamRef.current = null;
      if (channelRef.current) {
        void supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      offerSentRef.current = false;
      if (tokenRenewTimerRef.current) {
        clearInterval(tokenRenewTimerRef.current);
        tokenRenewTimerRef.current = null;
      }
      stopSpeaking();
      stopLocalDub();
      for (const synth of synthsRef.current.values()) {
        try {
          synth.close();
        } catch {
          /* already gone */
        }
      }
      synthsRef.current.clear();
      sdkCtxRef.current = null;
      dataChannelRef.current = null;
      setLocalStream(null);
      setRemoteStream(null);
      setStatus((s) => (s === "idle" ? "idle" : "ended"));
    },
    [stopLocalDub],
  );

  if (!releaseSelfRef.current) releaseSelfRef.current = () => hangup(true);

  useEffect(() => () => hangup(true), [hangup]);

  /** Build a TranslationRecognizer and surface its output as captions. */
  const startRecognizer = useCallback(
    (
      sdk: Sdk,
      token: string,
      region: string,
      who: "agent" | "guest",
      makeAudio: () => import("microsoft-cognitiveservices-speech-sdk").AudioConfig,
      endpoint: string,
      liveMode: boolean,
    ) => {
      const speakerLocale = who === "agent" ? agentLocaleRef.current : guestLocaleRef.current;
      const listener = callLanguage(
        who === "agent" ? guestLocaleRef.current : agentLocaleRef.current,
      );

      /**
       * Live Interpreter (Phase 2).
       *
       * The classic path is a chain: recognize -> translate -> a *separate*
       * SpeechSynthesizer round trip for the dub, with the input language
       * fixed up front. Live Interpreter collapses that into one socket: the
       * service detects the spoken language on its own (open range, so a
       * speaker switching language mid-call is handled), and returns the
       * translated *audio* on the recognizer's own `synthesizing` event. One
       * fewer network round trip per phrase, and no preset input language.
       *
       * It needs Azure's universal v2 endpoint — the region form of
       * SpeechTranslationConfig cannot reach it — and is not enabled on every
       * resource, so `useLive` gates it and `startContinuousRecognitionAsync`
       * failing falls back to the classic recognizer rather than killing the
       * call's translation entirely.
       */
      const useLive = liveMode && Boolean(NEURAL_VOICE_BY_TARGET[listener.target]);

      let config: import("microsoft-cognitiveservices-speech-sdk").SpeechTranslationConfig;
      let rec: TranslationRecognizer;

      if (useLive) {
        // Key is optional on fromEndpoint; the token is set afterwards, which
        // is the SDK's own documented way to use an auth token with an
        // endpoint. The browser still never sees AZURE_SPEECH_KEY.
        config = sdk.SpeechTranslationConfig.fromEndpoint(new URL(endpoint));
        config.authorizationToken = token;
        config.addTargetLanguage(listener.target);
        // Setting a voice is what turns on speech-to-speech output; without it
        // the service returns text only. Exactly one target language is
        // allowed when synthesis is on.
        config.voiceName = NEURAL_VOICE_BY_TARGET[listener.target]!;
        rec = sdk.TranslationRecognizer.FromConfig(
          config,
          // No candidate list: the point of Live Interpreter is that the
          // speaker's language is detected rather than declared.
          sdk.AutoDetectSourceLanguageConfig.fromOpenRange(),
          makeAudio(),
        );
      } else {
        config = sdk.SpeechTranslationConfig.fromAuthorizationToken(token, region);
        config.speechRecognitionLanguage = speakerLocale;
        config.addTargetLanguage(listener.target);
        rec = new sdk.TranslationRecognizer(config, makeAudio());
      }

      let phraseSeq = 0;
      let currentId = `${who}-${Date.now()}-0`;

      const emit = (e: TranslationRecognitionEventArgs, final: boolean) => {
        const original = e.result.text;
        if (!original) return;
        const translated = e.result.translations?.get(listener.target) ?? "";
        const entry: CaptionEntry = { id: currentId, who, original, translated, final };
        upsertCaption(entry);
        // The guest renders captions too — both their own words (original)
        // and the agent's words in the guest's language (translated).
        sendSignal({ kind: "caption", ...entry, lang: listener.target });
        // Speech-to-speech with Azure neural voices: the guest's finalized
        // phrases are dubbed into the agent's language here; the agent's
        // phrases are dubbed into the guest's language and shipped over the
        // data channel (the guest gates playback with its own toggle).
        // On the Live Interpreter path the audio arrives on `synthesizing`
        // instead, so synthesizing it again here would dub every phrase twice.
        if (final && translated && !useLive) {
          if (who === "guest" && voiceOnRef.current) void dubForAgent(translated, listener.target);
          if (who === "agent") void dubForGuest(translated, listener.target);
        }
        if (final) currentId = `${who}-${Date.now()}-${++phraseSeq}`;
      };

      if (useLive) {
        // Live Interpreter streams the translated speech back on this event.
        // A zero-length buffer marks the end of an utterance, not audio.
        rec.synthesizing = (
          _s: TranslationRecognizer,
          e: import("microsoft-cognitiveservices-speech-sdk").TranslationSynthesisEventArgs,
        ) => {
          const buf = e.result?.audio;
          if (!buf || buf.byteLength === 0) return;
          if (who === "guest") {
            // The guest's words, already spoken in the agent's language.
            if (voiceOnRef.current) enqueueDub(buf);
          } else {
            // The agent's words in the guest's language: ship the bytes over
            // the data channel exactly as the synthesized path does.
            sendDubToGuest(buf);
          }
        };
      }

      rec.recognizing = (_s: Recognizer, e: TranslationRecognitionEventArgs) => {
        if (e.result.reason === sdk.ResultReason.TranslatingSpeech) emit(e, false);
      };
      rec.recognized = (_s: Recognizer, e: TranslationRecognitionEventArgs) => {
        if (e.result.reason === sdk.ResultReason.TranslatedSpeech) emit(e, true);
      };
      rec.canceled = (_s: Recognizer, e: TranslationRecognitionCanceledEventArgs) => {
        if (e.reason === sdk.CancellationReason.Error) {
          onErrorRef.current?.(e.errorDetails || "Live translation stopped unexpectedly.");
        }
      };
      rec.startContinuousRecognitionAsync(
        () => {},
        (err: string) => {
          // Live Interpreter needs the v2 endpoint and is not enabled on every
          // Azure resource or region. Rather than leaving the call with no
          // translation at all, retry once on the classic path — which is the
          // behaviour this app shipped with — and only surface an error if
          // that fails too.
          if (useLive) {
            try {
              rec.close();
            } catch {
              /* nothing to close */
            }
            recognizersRef.current = recognizersRef.current.filter((r) => r !== rec);
            startRecognizerRef.current?.(sdk, token, region, who, makeAudio, endpoint, false);
            return;
          }
          onErrorRef.current?.(`Live translation could not start (${err}).`);
        },
      );
      recognizersRef.current.push(rec);
    },
    [sendSignal, upsertCaption, dubForAgent, dubForGuest, enqueueDub, sendDubToGuest],
  );

  // `startRecognizer` retries itself on the classic path when Live Interpreter
  // fails to start, which it cannot do by name inside its own definition.
  const startRecognizerRef = useRef<typeof startRecognizer | null>(null);
  startRecognizerRef.current = startRecognizer;

  /** The guest joined: create the peer, add our mic, send the offer. */
  const beginWebRtc = useCallback(
    async (sdk: Sdk, token: string, region: string) => {
      if (offerSentRef.current) return; // a repeated "join" ping — already handled
      offerSentRef.current = true;
      const mySession = sessionRef.current;
      setStatus("connecting");

      const peer = new RTCPeerConnection(rtcConfigRef.current);
      peerRef.current = peer;
      // Carries synthesized speech (agent's words in the guest's language).
      dataChannelRef.current = peer.createDataChannel(TTS_CHANNEL_LABEL);
      for (const track of micStreamRef.current!.getTracks()) {
        peer.addTrack(track, micStreamRef.current!);
      }
      peer.onicecandidate = (e) => {
        if (e.candidate) sendSignal({ kind: "ice", candidate: e.candidate.toJSON() });
      };
      let guestAudioStarted = false;
      peer.ontrack = (e) => {
        if (sessionRef.current !== mySession) return;
        const remote = e.streams[0] ?? new MediaStream([e.track]);
        setRemoteStream(remote);
        setStatus("live");
        // `ontrack` fires once per track (audio and, on video calls, video) —
        // the audio plumbing below must run exactly once.
        if (e.track.kind !== "audio" || guestAudioStarted) return;
        guestAudioStarted = true;
        const remoteAudio = new MediaStream(remote.getAudioTracks());
        remoteAudioStreamRef.current = remoteAudio;
        // Hear the guest.
        const audioEl = new Audio();
        audioEl.srcObject = remoteAudio;
        void audioEl.play().catch(() => {});
        remoteAudioElRef.current = audioEl;
        // Understand the guest: their audio goes into its own recognizer.
        startRecognizer(
          sdk,
          token,
          region,
          "guest",
          () => sdk.AudioConfig.fromStreamInput(remoteAudio),
          // Read from the context rather than closing over `start()`'s locals:
          // this fires whenever the guest's track arrives, which may be after
          // a token renewal has already refreshed the context.
          sdkCtxRef.current?.endpoint ?? "",
          sdkCtxRef.current?.liveInterpreter ?? false,
        );
      };
      peer.onconnectionstatechange = () => {
        if (sessionRef.current !== mySession) return;
        if (peer.connectionState === "failed") {
          onErrorRef.current?.(
            "The audio connection failed — the guest's network may block direct calls.",
          );
          hangup(true);
        }
      };

      const offer = await peer.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: videoRef.current,
      });
      await peer.setLocalDescription(offer);
      if (sessionRef.current !== mySession) return;
      sendSignal({ kind: "offer", sdp: offer.sdp!, video: videoRef.current });
    },
    [sendSignal, startRecognizer, hangup],
  );

  /** Agent presses "Start call": grab mic, open channel, wait for the guest. */
  const start = useCallback(async () => {
    const mySession = ++sessionRef.current;
    const stillCurrent = () => sessionRef.current === mySession;
    setCaptions([]);
    claimMicrophone(releaseSelfRef.current!);

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: videoRef.current,
      });
      if (!stillCurrent()) {
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      micStreamRef.current = mic;
      setLocalStream(mic);

      const [sdk, { token, region, endpoint, liveInterpreter }, rtcConfig] = await Promise.all([
        import("microsoft-cognitiveservices-speech-sdk"),
        getAzureSpeechToken({ data: {} }),
        fetchRtcConfig(),
      ]);
      if (!stillCurrent()) return;
      sdkCtxRef.current = { sdk, token, region, endpoint, liveInterpreter };
      rtcConfigRef.current = rtcConfig;

      // Azure auth tokens expire after ~10 minutes; renew every 8 so a long
      // call never loses recognition/synthesis mid-sentence. A failed renew
      // keeps the old token — the next tick simply tries again.
      if (tokenRenewTimerRef.current) clearInterval(tokenRenewTimerRef.current);
      tokenRenewTimerRef.current = setInterval(
        () => {
          void (async () => {
            try {
              const { token: fresh } = await getAzureSpeechToken({ data: {} });
              if (!stillCurrent()) return;
              if (sdkCtxRef.current) sdkCtxRef.current.token = fresh;
              for (const rec of recognizersRef.current) rec.authorizationToken = fresh;
              for (const synth of synthsRef.current.values()) synth.authorizationToken = fresh;
            } catch {
              /* transient — retried on the next tick */
            }
          })();
        },
        8 * 60 * 1000,
      );

      // The agent's own mic feeds its recognizer from the same MediaStream
      // WebRTC uses, so there is exactly one capture. The recognizer only
      // ever sees the audio track, even on video calls.
      startRecognizer(
        sdk,
        token,
        region,
        "agent",
        () => sdk.AudioConfig.fromStreamInput(new MediaStream(mic.getAudioTracks())),
        endpoint,
        liveInterpreter,
      );

      const channel = supabase.channel(`${CALL_CHANNEL_PREFIX}${roomId}`, {
        config: { broadcast: { self: false } },
      });
      channelRef.current = channel;
      channel.on("broadcast", { event: "signal" }, ({ payload }) => {
        if (!stillCurrent()) return;
        const signal = payload as CallSignal;
        // Always hand over the freshest token — the guest may join long
        // after `start()`, past the first token's ~10-minute lifetime.
        if (signal.kind === "join")
          void beginWebRtc(sdk, sdkCtxRef.current?.token ?? token, region);
        else if (signal.kind === "answer") {
          void peerRef.current?.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        } else if (signal.kind === "ice") {
          void peerRef.current?.addIceCandidate(signal.candidate).catch(() => {});
        } else if (signal.kind === "hangup" && signal.by === "guest") {
          onErrorRef.current?.("The guest left the call.");
          hangup(false);
        }
      });
      await new Promise<void>((resolve, reject) => {
        channel.subscribe((s) => {
          if (s === "SUBSCRIBED") resolve();
          if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") reject(new Error("signalling failed"));
        });
      });
      if (!stillCurrent()) return;
      setStatus("waiting");
    } catch (e) {
      if (!stillCurrent()) return;
      const raw = e instanceof Error ? e.message : "Could not start the call.";
      onErrorRef.current?.(
        /permission|notallowed|denied/i.test(raw)
          ? "Microphone access denied. Allow microphone access for this site, then try again."
          : raw,
      );
      hangup(false);
      setStatus("idle");
    }
  }, [roomId, beginWebRtc, startRecognizer, hangup]);

  const toggleMute = useCallback(() => {
    const mic = micStreamRef.current;
    if (!mic) return;
    const next = !muted;
    mic.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const mic = micStreamRef.current;
    if (!mic) return;
    const next = !cameraOff;
    mic.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
    setCameraOff(next);
  }, [cameraOff]);

  const toggleVoice = useCallback(() => {
    setVoiceOn((v) => {
      if (v) {
        stopSpeaking();
        stopLocalDub();
      }
      return !v;
    });
  }, [stopLocalDub]);

  const end = useCallback(() => hangup(true), [hangup]);

  /** Tell the guest the call is (no longer) being recorded. */
  const notifyRecording = useCallback(
    (on: boolean) => sendSignal({ kind: "recording", on }),
    [sendSignal],
  );

  /**
   * Mid-call language switch: tear down both recognizers and rebuild them
   * with the current locales. Captions keep flowing; the WebRTC audio path
   * is untouched. Synthesizers are per-target and created lazily, so new
   * targets simply get a new synthesizer on the next phrase.
   */
  const restartRecognizers = useCallback(() => {
    const ctx = sdkCtxRef.current;
    if (!ctx) return;
    for (const rec of recognizersRef.current) {
      try {
        rec.stopContinuousRecognitionAsync(
          () => rec.close(),
          () => rec.close(),
        );
      } catch {
        /* already gone */
      }
    }
    recognizersRef.current = [];
    if (micStreamRef.current) {
      startRecognizer(
        ctx.sdk,
        ctx.token,
        ctx.region,
        "agent",
        () =>
          ctx.sdk.AudioConfig.fromStreamInput(
            new MediaStream(micStreamRef.current!.getAudioTracks()),
          ),
        ctx.endpoint,
        ctx.liveInterpreter,
      );
    }
    if (remoteAudioStreamRef.current) {
      startRecognizer(
        ctx.sdk,
        ctx.token,
        ctx.region,
        "guest",
        () => ctx.sdk.AudioConfig.fromStreamInput(remoteAudioStreamRef.current!),
        ctx.endpoint,
        ctx.liveInterpreter,
      );
    }
  }, [startRecognizer]);

  return {
    status,
    captions,
    muted,
    cameraOff,
    voiceOn,
    localStream,
    remoteStream,
    start,
    end,
    toggleMute,
    toggleCamera,
    toggleVoice,
    notifyRecording,
    restartRecognizers,
  };
}

/**
 * Public call page — /call/$roomId
 *
 * The guest half of a translated voice/video call (see
 * src/lib/calls/translated-call.ts for the architecture). This page is
 * deliberately dumb: it answers the agent's WebRTC offer, plays the agent's
 * audio/video, renders the captions the agent's side broadcasts, and — for
 * speech-to-speech — speaks the agent's translated phrases aloud with the
 * browser's own TTS. It never touches Azure and needs no account; the room
 * id in the URL is the only credential, known just to the two people on the
 * call.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Mic, MicOff, Phone, PhoneOff, VideoOff, Volume2, VolumeX } from "lucide-react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import {
  CALL_CHANNEL_PREFIX,
  fetchRtcConfig,
  TTS_HEADER_PREFIX,
  type CallSignal,
  type CaptionEntry,
  sniffAudioMime,
} from "@/lib/calls/translated-call";

export const Route = createFileRoute("/call/$roomId")({
  component: GuestCallPage,
});

type GuestStatus = "idle" | "joining" | "live" | "ended" | "error";

function GuestCallPage() {
  const { roomId } = Route.useParams();
  const [status, setStatus] = useState<GuestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [captions, setCaptions] = useState<CaptionEntry[]>([]);
  const [muted, setMuted] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  // Consent notice: true while the agent's side is recording the call.
  const [recordingNotice, setRecordingNotice] = useState(false);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const joinTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  // Azure-synthesized speech arrives from the agent's side as MP3 phrases
  // over a WebRTC data channel; a small sequential queue plays them so
  // phrases never talk over each other.
  const playQueueRef = useRef<{ urls: string[]; playing: boolean; audio: HTMLAudioElement | null }>(
    { urls: [], playing: false, audio: null },
  );

  const stopDub = useCallback(() => {
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

  const cleanup = useCallback(
    (notifyAgent: boolean) => {
      if (joinTimerRef.current) {
        clearInterval(joinTimerRef.current);
        joinTimerRef.current = null;
      }
      if (notifyAgent) {
        void channelRef.current?.send({
          type: "broadcast",
          event: "signal",
          payload: { kind: "hangup", by: "guest" } satisfies CallSignal,
        });
      }
      stopDub();
      peerRef.current?.close();
      peerRef.current = null;
      micRef.current?.getTracks().forEach((t) => t.stop());
      micRef.current = null;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        remoteAudioRef.current = null;
      }
      if (channelRef.current) {
        void supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      setRemoteStream(null);
      setLocalStream(null);
    },
    [stopDub],
  );

  useEffect(() => () => cleanup(true), [cleanup]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);
  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  // Call timer.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status !== "live") return;
    const startedAt = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [status]);
  const timer = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  // A long unanswered wait usually means this link is from an older call
  // attempt (the other side restarted theirs) — say so instead of spinning.
  const [waitingLong, setWaitingLong] = useState(false);
  useEffect(() => {
    setWaitingLong(false);
    if (status !== "joining") return;
    const t = setTimeout(() => setWaitingLong(true), 20_000);
    return () => clearTimeout(t);
  }, [status]);

  // The link carries an advisory `exp` timestamp (see callRoomUrl). A link
  // opened past it gets a clear "expired" screen instead of an endless
  // spinner — but a call that is already live is never cut off by it.
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (status === "live" || status === "ended") return;
    const exp = Number(new URLSearchParams(window.location.search).get("exp") ?? "");
    if (!Number.isFinite(exp) || exp <= 0) return;
    const check = () => {
      if (Date.now() > exp) setExpired(true);
    };
    check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, [status]);

  // Expiring while still announcing "join" stops the loop and releases the
  // mic — the agent is clearly not coming to this room anymore.
  useEffect(() => {
    if (!expired || status !== "joining") return;
    cleanup(true);
    setStatus("idle");
  }, [expired, status, cleanup]);

  const join = useCallback(async () => {
    setStatus("joining");
    setError(null);
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("error");
      setError("Microphone access was denied. Allow it for this site and try again.");
      return;
    }
    micRef.current = mic;

    // STUN + Cloudflare TURN (when configured) — fetched up front so the
    // peer can relay through strict NATs. Falls back to STUN-only.
    const rtcConfig = await fetchRtcConfig();

    const channel = supabase.channel(`${CALL_CHANNEL_PREFIX}${roomId}`, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;

    const answerOffer = async (sdp: string, video: boolean) => {
      if (peerRef.current) return; // repeated offer — already answering
      setIsVideoCall(video);
      // On a video call, add our camera alongside the mic (best effort — an
      // audio-only guest is still a valid participant if the camera fails).
      if (video) {
        try {
          const cam = await navigator.mediaDevices.getUserMedia({ video: true });
          cam.getVideoTracks().forEach((t) => micRef.current?.addTrack(t));
        } catch {
          /* no camera — carry on with audio */
        }
      }
      const localMedia = micRef.current!;
      setLocalStream(localMedia);

      const peer = new RTCPeerConnection(rtcConfig);
      peerRef.current = peer;
      for (const track of localMedia.getTracks()) peer.addTrack(track, localMedia);
      peer.onicecandidate = (e) => {
        if (e.candidate) {
          void channel.send({
            type: "broadcast",
            event: "signal",
            payload: { kind: "ice", candidate: e.candidate.toJSON() } satisfies CallSignal,
          });
        }
      };
      // Synthesized speech (the agent's words, dubbed into our language).
      peer.ondatachannel = (e) => {
        const dc = e.channel;
        dc.binaryType = "arraybuffer";
        let expected = 0;
        let received: Uint8Array[] = [];
        let receivedBytes = 0;
        dc.onmessage = (msg) => {
          if (typeof msg.data === "string") {
            if (msg.data.startsWith(TTS_HEADER_PREFIX)) {
              expected = Number(msg.data.slice(TTS_HEADER_PREFIX.length)) || 0;
              received = [];
              receivedBytes = 0;
            }
            return;
          }
          if (!expected) return;
          const chunk = new Uint8Array(msg.data as ArrayBuffer);
          received.push(chunk);
          receivedBytes += chunk.byteLength;
          if (receivedBytes >= expected) {
            const full = new Uint8Array(receivedBytes);
            let offset = 0;
            for (const part of received) {
              full.set(part, offset);
              offset += part.byteLength;
            }
            expected = 0;
            received = [];
            if (voiceOnRef.current) enqueueDub(full.buffer);
          }
        };
      };

      let audioStarted = false;
      peer.ontrack = (e) => {
        const remote = e.streams[0] ?? new MediaStream([e.track]);
        setRemoteStream(remote);
        setStatus("live");
        if (e.track.kind !== "audio" || audioStarted) return;
        audioStarted = true;
        const audioEl = new Audio();
        audioEl.srcObject = new MediaStream(remote.getAudioTracks());
        void audioEl.play().catch(() => {});
        remoteAudioRef.current = audioEl;
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          cleanup(true);
          setStatus("error");
          setError("The connection failed. Ask for a fresh call link and try again.");
        }
      };
      await peer.setRemoteDescription({ type: "offer", sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      void channel.send({
        type: "broadcast",
        event: "signal",
        payload: { kind: "answer", sdp: answer.sdp! } satisfies CallSignal,
      });
    };

    channel.on("broadcast", { event: "signal" }, ({ payload }) => {
      const signal = payload as CallSignal;
      if (signal.kind === "offer") {
        if (joinTimerRef.current) {
          clearInterval(joinTimerRef.current);
          joinTimerRef.current = null;
        }
        void answerOffer(signal.sdp, !!signal.video);
      } else if (signal.kind === "ice") {
        void peerRef.current?.addIceCandidate(signal.candidate).catch(() => {});
      } else if (signal.kind === "hangup" && signal.by === "agent") {
        cleanup(false);
        setStatus("ended");
      } else if (signal.kind === "recording") {
        setRecordingNotice(signal.on);
      } else if (signal.kind === "caption") {
        setCaptions((prev) => {
          const i = prev.findIndex((c) => c.id === signal.id);
          const entry: CaptionEntry = {
            id: signal.id,
            who: signal.who,
            original: signal.original,
            translated: signal.translated,
            final: signal.final,
          };
          if (i === -1) return [...prev.slice(-80), entry];
          const next = prev.slice();
          next[i] = entry;
          return next;
        });
      }
    });

    channel.subscribe((s) => {
      if (s === "SUBSCRIBED") {
        // Keep announcing until the agent's offer arrives — the agent may
        // still be opening their side of the call.
        const announce = () => {
          void channel.send({
            type: "broadcast",
            event: "signal",
            payload: { kind: "join" } satisfies CallSignal,
          });
        };
        announce();
        joinTimerRef.current = setInterval(announce, 2000);

        // The broadcast above only rings an inbox tab that is open and
        // listening. This also pushes an OS-level notification so the agent is
        // reached with the tab backgrounded or closed. Fire-and-forget: push is
        // an enhancement and must never delay or block joining the call.
        void (async () => {
          try {
            const { notifyIncomingCall } = await import("@/lib/push/push.functions");
            await notifyIncomingCall({ data: { room_id: roomId } });
          } catch {
            /* the in-tab ring still works */
          }
        })();
      } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
        cleanup(false);
        setStatus("error");
        setError("Could not reach the call service. Check your connection and reload.");
      }
    });
  }, [roomId, cleanup, enqueueDub]);

  const toggleMute = () => {
    const mic = micRef.current;
    if (!mic) return;
    const next = !muted;
    mic.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
  };

  const toggleVoice = () => {
    setVoiceOn((v) => {
      if (v) stopDub();
      return !v;
    });
  };

  const leave = () => {
    cleanup(true);
    setStatus("ended");
  };

  // Subtitle overlay: the last phrase from each side.
  const lastAgent = [...captions].reverse().find((c) => c.who === "agent");
  const lastGuest = [...captions].reverse().find((c) => c.who === "guest");
  const hasRemoteVideo = isVideoCall && !!remoteStream?.getVideoTracks().length;
  const linkExpired = expired && (status === "idle" || status === "joining");

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-gradient-to-b from-zinc-900 via-zinc-950 to-black text-zinc-100">
      <div className="pointer-events-none absolute -top-32 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-emerald-500/15 blur-[120px]" />

      {/* Recording consent notice — a small corner badge, not a banner */}
      {recordingNotice && status === "live" && (
        <div
          title="This call is being recorded"
          className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-red-600/90 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg backdrop-blur"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          REC
        </div>
      )}

      {/* Stage */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6">
        {hasRemoteVideo ? (
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            // The call's audio already plays through a dedicated element;
            // an unmuted video would double it (echo).
            muted
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center gap-5 text-center">
            <div className="relative">
              {status === "live" && (
                <>
                  <span className="absolute inset-0 -m-4 animate-ping rounded-full bg-emerald-500/20" />
                  <span className="absolute inset-0 -m-8 animate-pulse rounded-full bg-emerald-500/10" />
                </>
              )}
              <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/15 ring-4 ring-white/10 shadow-2xl">
                <Phone className="h-10 w-10 text-emerald-400" />
              </div>
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">
                {linkExpired && "This call link has expired"}
                {!linkExpired && status === "idle" && "You're invited to a translated call"}
                {!linkExpired && status === "joining" && "Connecting…"}
                {status === "live" && "On call"}
                {status === "ended" && "Call ended"}
                {status === "error" && "Something went wrong"}
              </h1>
              <p className="mt-1 flex items-center justify-center gap-2 text-sm text-zinc-400">
                {linkExpired &&
                  "Ask them to send you a fresh call link in the chat and open that one instead."}
                {!linkExpired &&
                  status === "idle" &&
                  "Speak your own language — you'll hear and read theirs in yours."}
                {!linkExpired && status === "joining" && (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for the other side…
                  </>
                )}
                {status === "live" && (
                  <>
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" /> {timer}
                  </>
                )}
                {status === "ended" && "You can close this page."}
              </p>
              {!linkExpired && status === "joining" && waitingLong && (
                <p className="mt-2 max-w-xs text-xs text-zinc-500">
                  Taking long? This link may be from an earlier call — ask them to send you a fresh
                  one and open that instead.
                </p>
              )}
            </div>
            {error && (
              <p className="max-w-sm rounded-lg bg-red-500/10 px-4 py-2 text-sm text-red-300">
                {error}
              </p>
            )}
            {status === "idle" && !linkExpired && (
              <button
                type="button"
                onClick={() => void join()}
                className="flex h-12 items-center gap-2 rounded-full bg-emerald-600 px-8 text-sm font-semibold text-white shadow-lg transition hover:bg-emerald-500 active:scale-95"
              >
                <Phone className="h-4 w-4" /> Join call
              </button>
            )}
          </div>
        )}

        {/* Video-call chip + local preview */}
        {hasRemoteVideo && (
          <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs text-white backdrop-blur">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" /> {timer}
          </div>
        )}
        {isVideoCall && localStream && localStream.getVideoTracks().length > 0 && (
          <div className="absolute bottom-24 right-4 h-28 w-44 overflow-hidden rounded-xl border border-white/15 bg-black/60 shadow-2xl">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full scale-x-[-1] object-cover"
            />
          </div>
        )}
        {isVideoCall && localStream && localStream.getVideoTracks().length === 0 && (
          <div className="absolute bottom-24 right-4 flex h-28 w-44 items-center justify-center rounded-xl border border-white/15 bg-black/60 text-xs text-zinc-400 shadow-2xl">
            <VideoOff className="mr-1.5 h-4 w-4" /> No camera
          </div>
        )}

        {/* Subtitle overlay — the guest reads the agent's words in the
            guest's own language, and their own words as spoken. */}
        {(lastAgent || lastGuest) && status === "live" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-24 flex flex-col items-center gap-1.5 px-6">
            {lastAgent && (
              <p className="max-w-2xl rounded-xl bg-black/60 px-4 py-2 text-center text-sm text-white backdrop-blur">
                <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
                  Them
                </span>
                {lastAgent.translated || lastAgent.original}
              </p>
            )}
            {lastGuest && (
              <p className="max-w-2xl rounded-xl bg-black/40 px-4 py-1.5 text-center text-xs text-zinc-300 backdrop-blur">
                <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-sky-400">
                  You
                </span>
                {lastGuest.original}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Control bar */}
      {(status === "live" || status === "joining") && (
        <div className="relative z-10 flex items-center justify-center px-4 pb-6 pt-2">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 shadow-2xl backdrop-blur-xl">
            <button
              type="button"
              onClick={toggleMute}
              title={muted ? "Unmute" : "Mute"}
              aria-label={muted ? "Unmute" : "Mute"}
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-full transition active:scale-95",
                muted ? "bg-white text-zinc-900" : "bg-white/10 text-white hover:bg-white/20",
              )}
            >
              {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </button>
            <button
              type="button"
              onClick={toggleVoice}
              title={voiceOn ? "Voice translation on — tap to mute it" : "Voice translation off"}
              aria-label="Toggle voice translation"
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-full transition active:scale-95",
                !voiceOn ? "bg-white text-zinc-900" : "bg-white/10 text-white hover:bg-white/20",
              )}
            >
              {voiceOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
            </button>
            <button
              type="button"
              onClick={leave}
              title="Leave call"
              aria-label="Leave call"
              className="flex h-11 w-14 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition hover:bg-red-500 active:scale-95"
            >
              <PhoneOff className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

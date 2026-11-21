/**
 * Incoming-call alert for the agent.
 *
 * A guest who opens a call link broadcasts `join` on the room's channel every
 * two seconds — but the agent only hears it while sitting on the call canvas
 * with the call started. This hook listens for those joins from anywhere in
 * the app: it watches the rooms this browser tab has handed out (the
 * `trcall-room:<conversationId>` sessionStorage entries written by the call
 * canvas) and, when a guest turns up, rings and surfaces the call.
 *
 * The alert used to be a sonner toast. It is now a modal (see
 * `IncomingCallDialog`), because a toast is easy to miss, auto-dismisses, and
 * has room for exactly one action — a ringing phone needs answer, decline,
 * mute and "open the conversation first" side by side.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { CALL_CHANNEL_PREFIX, type CallSignal } from "@/lib/calls/translated-call";

const ROOM_KEY_PREFIX = "trcall-room:";
const ALERT_MS = 30_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
const sbAny = (c: unknown) => c as any;

/** One guest waiting on a room this tab handed out. */
export type IncomingCall = {
  roomId: string;
  conversationId: string;
  /** When the alert started, for the "ringing for Ns" counter. */
  startedAt: number;
};

/* ------------------------------------------------------------------ */
/* Ringtone preference                                                 */
/* ------------------------------------------------------------------ */

const RING_PREF_KEY = "trcall-ring-muted";

export function isCallRingMuted(): boolean {
  return typeof window !== "undefined" && localStorage.getItem(RING_PREF_KEY) === "1";
}

export function setCallRingMuted(muted: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(RING_PREF_KEY, muted ? "1" : "0");
  mutedListeners.forEach((fn) => fn());
}

const mutedListeners = new Set<() => void>();

/** Reactive view of the ringtone preference, so the dialog's toggle updates. */
export function useCallRingMuted(): [boolean, (muted: boolean) => void] {
  const muted = useSyncExternalStore(
    (onChange) => {
      mutedListeners.add(onChange);
      return () => mutedListeners.delete(onChange);
    },
    isCallRingMuted,
    () => false,
  );
  return [muted, setCallRingMuted];
}

/* ------------------------------------------------------------------ */
/* Suppression + answer handoff                                        */
/* ------------------------------------------------------------------ */

/**
 * The alert is mounted once for the whole app, but the call canvas — which
 * handles guest joins itself — lives inside the inbox. These let the inbox
 * silence the global alert while its call screen is open.
 */
let suppressed = false;
const suppressListeners = new Set<() => void>();

function emitSuppressed() {
  suppressListeners.forEach((fn) => fn());
}

export function useSuppressIncomingCalls(value: boolean) {
  useEffect(() => {
    suppressed = value;
    emitSuppressed();
    return () => {
      suppressed = false;
      emitSuppressed();
    };
  }, [value]);
}

function useIsSuppressed(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      suppressListeners.add(onChange);
      return () => suppressListeners.delete(onChange);
    },
    () => suppressed,
    () => false,
  );
}

/**
 * The inbox knows how to open a conversation straight into its call screen
 * without a page load. When it is mounted it registers that here, so
 * answering from the modal is instant; from any other page the dialog falls
 * back to navigating to the inbox.
 */
let answerHandler: ((conversationId: string) => void) | null = null;

export function registerCallAnswerHandler(fn: (conversationId: string) => void): () => void {
  answerHandler = fn;
  return () => {
    if (answerHandler === fn) answerHandler = null;
  };
}

/** Returns false when nothing could handle it and the caller should navigate. */
export function requestCallAnswer(conversationId: string): boolean {
  if (!answerHandler) return false;
  answerHandler(conversationId);
  return true;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The customer opened the call link and waited, but nobody answered the
 * alert — leave a "missed call" note in the thread so it can be followed up.
 * Best effort: a failed insert only means a missing note, never a broken UI.
 */
async function logMissedCall(conversationId: string) {
  try {
    const [{ data: conv }, { data: auth }] = await Promise.all([
      supabase
        .from("conversations")
        .select("id,workspace_id")
        .eq("id", conversationId)
        .maybeSingle(),
      supabase.auth.getUser(),
    ]);
    if (!conv) return;
    await sbAny(supabase)
      .from("messages")
      .insert({
        workspace_id: (conv as { workspace_id: string }).workspace_id,
        conversation_id: conversationId,
        direction: "inbound",
        message_type: "system",
        status: "sent",
        body: "Missed call — they opened the call link, but the call wasn't answered.",
        sent_by: auth.user?.id ?? null,
        metadata: { missed_call: { at: new Date().toISOString() } },
      });
  } catch {
    /* best effort */
  }
}

/** The rooms this tab has handed out, as `roomId → conversationId`. */
function scanRooms(): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof window === "undefined") return out;
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(ROOM_KEY_PREFIX)) continue;
    const raw = sessionStorage.getItem(key);
    if (!raw) continue;
    // Stored as `{id, exp}` JSON (legacy entries were the bare room id).
    let roomId = raw;
    try {
      const parsed = JSON.parse(raw) as { id?: string; exp?: number };
      if (parsed?.id) {
        if (typeof parsed.exp === "number" && parsed.exp <= Date.now()) continue; // expired
        roomId = parsed.id;
      }
    } catch {
      /* legacy bare id */
    }
    out.set(roomId, key.slice(ROOM_KEY_PREFIX.length));
  }
  return out;
}

/**
 * Raises an OS notification while the tab is hidden, and returns a function
 * that closes it again (called when the alert is answered, declined or times
 * out, so a stale "Incoming call" banner never outlives the ring).
 *
 * No-ops when the page is visible — the on-screen modal is better there — and
 * when permission has not been granted. It deliberately never *asks* for
 * permission: prompting at the moment a call arrives would steal focus from
 * the ring. The user grants it from the call panel's own toggle instead.
 */
function showHiddenTabNotification(
  roomId: string,
  conversationId: string,
  onAnswer: () => void,
): () => void {
  if (typeof window === "undefined" || !("Notification" in window)) return () => undefined;
  if (Notification.permission !== "granted") return () => undefined;
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    return () => undefined;
  }
  try {
    const note = new Notification("Incoming call", {
      body: "The customer opened your call link and is waiting.",
      tag: `incoming-call-${roomId}`,
      icon: "/icon-192.png",
      requireInteraction: true,
    });
    note.onclick = () => {
      window.focus();
      note.close();
      onAnswer();
    };
    void conversationId;
    return () => {
      try {
        note.close();
      } catch {
        /* already gone */
      }
    };
  } catch {
    return () => undefined;
  }
}

/** A soft two-tone ring through Web Audio — no asset file needed. */
function startRing(): () => void {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
  } catch {
    return () => undefined;
  }
  const audio = ctx;
  let stopped = false;
  const beep = (freq: number, at: number, dur: number) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.03);
    gain.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + dur);
  };
  const ringOnce = () => {
    if (stopped) return;
    const t = audio.currentTime;
    beep(880, t, 0.25);
    beep(660, t + 0.3, 0.25);
  };
  ringOnce();
  const timer = setInterval(ringOnce, 2000);
  return () => {
    stopped = true;
    clearInterval(timer);
    void audio.close().catch(() => undefined);
  };
}

/* ------------------------------------------------------------------ */
/* The hook                                                            */
/* ------------------------------------------------------------------ */

export type IncomingCallsApi = {
  calls: IncomingCall[];
  /** Hand the call to the inbox (or report that the caller must navigate). */
  answer: (call: IncomingCall) => boolean;
  /** Stop ringing and record the missed call, as a timeout would. */
  decline: (call: IncomingCall) => void;
  /** Stop ringing without recording anything — the agent is on their way. */
  dismiss: (call: IncomingCall) => void;
  /** Silences the current ring and every later one, until turned back on. */
  muted: boolean;
  setMuted: (muted: boolean) => void;
};

export function useIncomingCalls(): IncomingCallsApi {
  const isSuppressed = useIsSuppressed();
  const [calls, setCalls] = useState<IncomingCall[]>([]);
  const [muted, setMutedPref] = useCallRingMuted();

  /** Per-room teardown: stops the ring, timer and OS notification. */
  const ringingRef = useRef(new Map<string, () => void>());
  /** Per-room ring stoppers alone, so muting can silence without clearing. */
  const stopRingRef = useRef(new Map<string, () => void>());
  const missedLoggedRef = useRef(new Set<string>());

  const clearAlert = useCallback((roomId: string) => {
    ringingRef.current.get(roomId)?.();
    ringingRef.current.delete(roomId);
    stopRingRef.current.delete(roomId);
    setCalls((list) => list.filter((c) => c.roomId !== roomId));
  }, []);

  useEffect(() => {
    if (isSuppressed) return;

    const channels: RealtimeChannel[] = [];
    const ringing = ringingRef.current;
    const stoppers = stopRingRef.current;
    const missedLogged = missedLoggedRef.current;

    for (const [roomId, conversationId] of scanRooms()) {
      const channel = supabase.channel(`${CALL_CHANNEL_PREFIX}${roomId}`, {
        config: { broadcast: { self: false } },
      });
      channel.on("broadcast", { event: "signal" }, ({ payload }) => {
        const signal = payload as CallSignal;
        // One alert per room at a time; the guest re-broadcasts every 2s.
        if (signal?.kind !== "join" || ringing.has(roomId)) return;

        const stopRing = isCallRingMuted() ? () => undefined : startRing();
        stoppers.set(roomId, stopRing);

        // A modal is invisible on a backgrounded tab. When the page is hidden,
        // raise an OS-level notification too. This is the cheap local path (no
        // server, no push service) and covers the common "tab open but
        // minimised" case; true Web Push covers the closed-tab case.
        const localNote = showHiddenTabNotification(roomId, conversationId, () => {
          if (!requestCallAnswer(conversationId)) {
            window.location.assign(`/inbox?call=${encodeURIComponent(conversationId)}`);
          }
          clearAlert(roomId);
        });

        const expiry = setTimeout(() => {
          clearAlert(roomId);
          // Unanswered until the alert timed out: that's a missed call. Once
          // per room per subscription, so the guest's continued 2-second join
          // pings don't stack up duplicate notes.
          if (!missedLogged.has(roomId)) {
            missedLogged.add(roomId);
            void logMissedCall(conversationId);
          }
        }, ALERT_MS);

        ringing.set(roomId, () => {
          stoppers.get(roomId)?.();
          clearTimeout(expiry);
          localNote();
        });

        setCalls((list) =>
          list.some((c) => c.roomId === roomId)
            ? list
            : [...list, { roomId, conversationId, startedAt: Date.now() }],
        );
      });
      channel.subscribe();
      channels.push(channel);
    }

    return () => {
      for (const stop of ringing.values()) stop();
      ringing.clear();
      stoppers.clear();
      setCalls([]);
      for (const channel of channels) void supabase.removeChannel(channel);
    };
  }, [isSuppressed, clearAlert]);

  const answer = useCallback(
    (call: IncomingCall) => {
      clearAlert(call.roomId);
      return requestCallAnswer(call.conversationId);
    },
    [clearAlert],
  );

  const decline = useCallback(
    (call: IncomingCall) => {
      clearAlert(call.roomId);
      // Declining is a missed call from the customer's side: they opened the
      // link and nobody took it, which is exactly what the note records.
      if (!missedLoggedRef.current.has(call.roomId)) {
        missedLoggedRef.current.add(call.roomId);
        void logMissedCall(call.conversationId);
      }
    },
    [clearAlert],
  );

  const dismiss = useCallback((call: IncomingCall) => clearAlert(call.roomId), [clearAlert]);

  const setMuted = useCallback(
    (next: boolean) => {
      setMutedPref(next);
      // Silence what is ringing right now, not just the next call.
      if (next) {
        for (const stop of stopRingRef.current.values()) stop();
        stopRingRef.current.clear();
      }
    },
    [setMutedPref],
  );

  return { calls, answer, decline, dismiss, muted, setMuted };
}

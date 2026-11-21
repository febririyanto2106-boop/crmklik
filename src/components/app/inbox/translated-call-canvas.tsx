/**
 * Full-pane call screen, styled like a real calling app: a dark immersive
 * stage (remote video on video calls, a pulsing avatar on voice calls),
 * subtitle-style live translated captions, and a floating glass control bar.
 *
 * Chat and call stay exclusive: the header's call button swaps the thread
 * for this canvas (inbox.tsx owns that switch) and "Back to chat" ends any
 * live call and swaps the thread back.
 *
 * All the machinery lives in `useTranslatedCall`; this file is layout and
 * controls only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  BellRing,
  Captions,
  Check,
  CheckSquare,
  CircleDot,
  Copy,
  Download,
  History,
  Link2,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Send,
  Smartphone,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import { buildTemplateSendPayload } from "@/lib/messaging/template-send-payload";
import {
  getCallInviteContext,
  type CallInviteTemplate,
} from "@/lib/calls/invite-window.functions";
import {
  fillInviteTemplate,
  inviteTemplateBody,
  type InviteFill,
} from "@/lib/calls/invite-template";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useTranslatedCall } from "@/hooks/use-translated-call";
import { CALL_LANGUAGES, CALL_LINK_TTL_MS, callRoomUrl } from "@/lib/calls/translated-call";
import {
  downloadCallTranscript,
  formatCallDuration,
  saveCallLogToConversation,
  summarizeCall,
  type CallLogInput,
} from "@/lib/calls/call-log";
import { CreateTaskDialog } from "./create-task-dialog";
import { isCallRingMuted, setCallRingMuted } from "@/hooks/use-incoming-call-alert";
import {
  readTranslatedCallMeta,
  type TranslatedCallMeta,
} from "@/components/app/inbox/translated-call-log-card";
import { supabase } from "@/integrations/supabase/client";
import { uploadAttachment, useSendMessage } from "@/hooks/use-messages";
import type { ConversationRow } from "@/hooks/use-conversations";
import { cn } from "@/lib/utils";

// The canvas is always dark regardless of the app theme, so the shadcn
// Select's theme-variable styling (white border/background in light mode)
// is overridden with fixed dark values here.
const darkSelectTrigger =
  "w-full !border-zinc-700 !bg-zinc-900/90 !text-zinc-100 !shadow-none !ring-0 !ring-offset-0 hover:!bg-zinc-800 focus:!border-zinc-500 focus:!ring-0 [&>svg]:!text-zinc-400";
const darkSelectContent = "!border-zinc-700 !bg-zinc-900 !text-zinc-100 !outline-none !shadow-xl";
// `menuItemClass` paints items with the app theme (`text-foreground/75`,
// hover `bg-muted`) — black-on-dark in light mode, so every state needs an
// explicit (important) dark override here.
const darkSelectItem =
  "!text-zinc-200 hover:!bg-zinc-800 hover:!text-white focus:!bg-zinc-800 focus:!text-white data-[highlighted]:!bg-zinc-800 data-[highlighted]:!text-white data-[state=checked]:!text-white";

export function TranslatedCallCanvas({
  conversation,
  contactName,
  avatarUrl,
  initials,
  onBackToChat,
  autoStart,
}: {
  /** The conversation this call belongs to — the transcript is saved into it. */
  conversation: ConversationRow;
  contactName: string;
  avatarUrl?: string | null;
  initials: string;
  /** Leaves the call screen (ending any live call) and shows the chat again. */
  onBackToChat: () => void;
  /** Start the call immediately — used when answering an incoming-call alert. */
  autoStart?: boolean;
}) {
  // Persisted per conversation (not just per mount): switching to chat and
  // back, or a page reload/HMR remount while a link is already sent, must
  // NOT silently swap the room id — that would strand a link already in the
  // guest's hands on a channel nobody is listening on anymore. The id is
  // cleared only once a call actually connects and then ends, so a fresh
  // "Call again" after a finished call still gets a clean room.
  const roomStorageKey = `trcall-room:${conversation.id}`;
  const roomIdRef = useRef<string>("");
  const roomExpRef = useRef(0);
  if (!roomIdRef.current && typeof window !== "undefined") {
    let id = "";
    let exp = 0;
    const stored = sessionStorage.getItem(roomStorageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { id?: string; exp?: number };
        // An expired stored room is retired here: any link carrying it is
        // already refused by the guest page, so reusing it helps nobody.
        if (parsed?.id && typeof parsed.exp === "number" && parsed.exp > Date.now()) {
          id = parsed.id;
          exp = parsed.exp;
        }
      } catch {
        // Legacy value: a bare room id from before links carried an expiry.
        id = stored;
        exp = Date.now() + CALL_LINK_TTL_MS;
      }
    }
    if (!id) {
      id = crypto.randomUUID();
      exp = Date.now() + CALL_LINK_TTL_MS;
    }
    roomIdRef.current = id;
    roomExpRef.current = exp;
    sessionStorage.setItem(roomStorageKey, JSON.stringify({ id, exp }));
  }

  const [agentLocale, setAgentLocale] = useState("bn-IN");
  const [guestLocale, setGuestLocale] = useState("en-US");
  const [callType, setCallType] = useState<"voice" | "video">("voice");
  const [copied, setCopied] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  const {
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
  } = useTranslatedCall({
    roomId: roomIdRef.current,
    agentLocale,
    guestLocale,
    video: callType === "video",
    onError: (message) => toast.error(message),
  });

  const link = useMemo(() => callRoomUrl(roomIdRef.current, roomExpRef.current), []);

  // Register the room so the public guest page can resolve roomId -> this
  // agent and push them an alert on join. Done once per room as soon as the
  // canvas opens, which covers both "send link in chat" and "copy link".
  // Best-effort: if it fails, the in-tab ring still works exactly as before.
  const roomRegisteredRef = useRef("");
  useEffect(() => {
    const id = roomIdRef.current;
    if (!id || roomRegisteredRef.current === id || !conversation.workspace_id) return;
    roomRegisteredRef.current = id;
    void (async () => {
      try {
        const { registerCallRoom } = await import("@/lib/push/push.functions");
        await registerCallRoom({
          data: {
            room_id: id,
            conversation_id: conversation.id,
            workspace_id: conversation.workspace_id,
            contact_name: contactName,
            call_type: callType === "video" ? "video" : "voice",
            expires_at: roomExpRef.current || Date.now() + CALL_LINK_TTL_MS,
          },
        });
      } catch {
        /* push alerts stay off for this room */
      }
    })();
  }, [conversation.id, conversation.workspace_id, contactName, callType]);

  // Mid-call language switch: once either locale changes during a call, the
  // recognizers are rebuilt with the new pair. Runs as an effect so the
  // hook's locale refs (updated on render) are already fresh.
  const localesAppliedRef = useRef(`${agentLocale}|${guestLocale}`);
  useEffect(() => {
    const key = `${agentLocale}|${guestLocale}`;
    if (localesAppliedRef.current === key) return;
    localesAppliedRef.current = key;
    if (status !== "live" && status !== "connecting" && status !== "waiting") return;
    restartRecognizers();
    toast.success("Languages switched", {
      description: "Live translation now uses the new language pair.",
    });
  }, [agentLocale, guestLocale, status, restartRecognizers]);

  // Answering an incoming-call alert lands here with the guest already on
  // the room — go straight to "waiting" so the call connects immediately.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || status !== "idle") return;
    autoStartedRef.current = true;
    void start();
  }, [autoStart, status, start]);

  const inCall = status === "waiting" || status === "connecting" || status === "live";

  /* ---------------- Call log: save into the chat when the call ends ------- */

  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const push = usePushNotifications();
  const [ringMuted, setRingMuted] = useState(() => isCallRingMuted());
  const toggleRingMuted = () => {
    setRingMuted((v) => {
      setCallRingMuted(!v);
      toast.info(
        !v
          ? "Incoming-call ringtone muted — you'll still get the Answer toast."
          : "Incoming-call ringtone on.",
      );
      return !v;
    });
  };
  const liveSinceRef = useRef<number | null>(null);
  const savedRef = useRef(false);
  const lastSummaryRef = useRef<string | null>(null);
  // Only a call that actually connected should retire its room id — an
  // unanswered "waiting" call still has a just-sent link pointing at it, and
  // that link must keep working if the canvas remounts before anyone joins.
  const hadConnectedRef = useRef(false);

  /* ---------------- Call recording (agent side, both voices mixed) -------- */
  // A Web Audio graph mixes the agent's mic and the guest's incoming audio
  // into one stream for MediaRecorder — recording either stream alone would
  // capture only half the conversation. Audio-only by design: the insight
  // value is in the words, and an audio file stays small enough to live in
  // the normal attachments bucket.
  const [recordingOn, setRecordingOn] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordCtxRef = useRef<AudioContext | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  // The finished file, kept until the call-log save picks it up. Starting a
  // new recording in the same call replaces it (webm chunks from separate
  // recorder sessions cannot be concatenated client-side).
  const recordingBlobRef = useRef<Blob | null>(null);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    setRecordingOn(false);
    const ctx = recordCtxRef.current;
    recordCtxRef.current = null;
    if (!rec || rec.state === "inactive") {
      void ctx?.close().catch(() => undefined);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      rec.onstop = () => {
        void ctx?.close().catch(() => undefined);
        const chunks = recordChunksRef.current;
        recordChunksRef.current = [];
        const blob = chunks.length ? new Blob(chunks, { type: "audio/webm" }) : null;
        if (blob) recordingBlobRef.current = blob;
        resolve(blob);
      };
      rec.stop();
    });
  }, []);

  const startRecording = useCallback(() => {
    if (recorderRef.current) return;
    if (!localStream) {
      toast.error("Recording needs an active call");
      return;
    }
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      if (localStream.getAudioTracks().length) {
        ctx.createMediaStreamSource(localStream).connect(dest);
      }
      if (remoteStream?.getAudioTracks().length) {
        ctx.createMediaStreamSource(remoteStream).connect(dest);
      }
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(dest.stream, { mimeType: mime });
      recordChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      rec.start(1000);
      recorderRef.current = rec;
      recordCtxRef.current = ctx;
      setRecordingOn(true);
      notifyRecording(true); // consent notice on the guest's screen
      toast.success("Recording started", {
        description:
          "Both voices are being recorded; the file is saved to the chat after the call.",
      });
    } catch (e) {
      toast.error("Could not start recording", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }, [localStream, remoteStream, notifyRecording]);

  const toggleRecording = useCallback(() => {
    if (recorderRef.current) {
      void stopRecording();
      notifyRecording(false);
      toast.info("Recording stopped — it will still be saved with the call.");
    } else {
      startRecording();
    }
  }, [startRecording, stopRecording, notifyRecording]);

  // The recorder must never outlive the canvas.
  useEffect(() => () => void stopRecording(), [stopRecording]);

  const callLogInput = useCallback(
    (): CallLogInput => ({
      workspaceId: conversation.workspace_id,
      conversationId: conversation.id,
      contactName,
      callType,
      durationSec: liveSinceRef.current
        ? Math.max(1, Math.round((Date.now() - liveSinceRef.current) / 1000))
        : 0,
      agentLocale,
      guestLocale,
      captions,
    }),
    [
      conversation.workspace_id,
      conversation.id,
      contactName,
      callType,
      agentLocale,
      guestLocale,
      captions,
    ],
  );

  useEffect(() => {
    if (status === "live") {
      if (liveSinceRef.current === null) liveSinceRef.current = Date.now();
      hadConnectedRef.current = true;
    }
    if (status === "waiting") {
      // a fresh call attempt — allow a new save afterwards
      liveSinceRef.current = null;
      savedRef.current = false;
      lastSummaryRef.current = null;
      recordingBlobRef.current = null;
    }
    if (status === "ended" && hadConnectedRef.current && typeof window !== "undefined") {
      // This room was actually used — retire it so a later remount (new
      // visit to this conversation's call screen) starts clean rather than
      // rejoining a channel whose other side is long gone.
      sessionStorage.removeItem(roomStorageKey);
      hadConnectedRef.current = false;
    }
    if (status !== "ended" || savedRef.current) return;
    const input = callLogInput();
    const spoke = input.captions.some((c) => c.final && c.original);
    const hasRecording = !!recorderRef.current || !!recordingBlobRef.current;
    if (!spoke && !hasRecording) return; // nothing was said and nothing recorded
    savedRef.current = true;
    void (async () => {
      // Flush the recorder first so the finished file is ready to upload.
      await stopRecording();
      let recording: Awaited<ReturnType<typeof uploadAttachment>> | null = null;
      const blob = recordingBlobRef.current;
      if (blob) {
        try {
          recording = await uploadAttachment(
            input.workspaceId,
            input.conversationId,
            blob,
            `call-recording-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.webm`,
          );
        } catch (e) {
          toast.error("Could not upload the call recording", {
            description: e instanceof Error ? e.message : undefined,
          });
        }
      }
      const summary = await summarizeCall(input);
      lastSummaryRef.current = summary;
      try {
        await saveCallLogToConversation(input, summary, recording);
        toast.success("Call saved to the conversation", {
          description: summary ?? "Transcript added to the chat history.",
        });
      } catch (e) {
        savedRef.current = false; // let "Call again"/retry attempt a re-save
        toast.error("Could not save the call to the chat", {
          description: e instanceof Error ? e.message : undefined,
        });
      }
    })();
  }, [status, callLogInput, roomStorageKey, stopRecording]);

  const hasTranscript = captions.some((c) => c.final && c.original);

  /* ------- Deliver the call link to the contact over their own channel ---- */
  // The guest page is public (no account needed) — the contact just needs to
  // receive the URL. This sends it as a normal outbound message through the
  // conversation's channel (WhatsApp etc.), so they get a real notification
  // on their side.
  const sendMessage = useSendMessage();
  const [linkSent, setLinkSent] = useState(false);

  // WhatsApp only accepts free-form messages for 24 hours after the customer's
  // last reply. Past that, the plain-text invite below is rejected by Meta and
  // the customer never learns a call is waiting — so the send has to switch to
  // an approved template. Fetched lazily and kept fresh for a minute; this is
  // only consulted when the agent actually sends.
  const [templateOpen, setTemplateOpen] = useState(false);
  const inviteContext = useQuery({
    queryKey: ["call-invite-context", conversation.id],
    queryFn: () => getCallInviteContext({ data: { conversationId: conversation.id } }),
    staleTime: 60_000,
  });
  const windowClosed = inviteContext.data?.isWhatsApp && !inviteContext.data.insideWindow;

  const sendLinkInChat = async () => {
    // Outside the window a free-form send would simply fail at Meta. Open the
    // template picker instead of letting the agent fire a doomed message.
    if (windowClosed) {
      setTemplateOpen(true);
      return;
    }
    try {
      await sendMessage.mutateAsync({
        conversationId: conversation.id,
        body:
          `I'd like to talk with you on a quick ${callType} call. ` +
          `Tap this link to join — it opens right in your browser, no app or account needed, ` +
          `and we can each speak our own language with live translation:\n${link}`,
        // Lets the inbox render this as a rich call-invite card (sender,
        // message, clickable link preview) instead of a plain text bubble.
        metadata: {
          call_invite: {
            url: link,
            call_type: callType,
            expires_at: roomExpRef.current || null,
          },
        },
      });
      setLinkSent(true);
      toast.success(`Call link sent to ${contactName} in the chat`);
    } catch (e) {
      toast.error("Could not send the call link", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  /**
   * Sends the invite as an approved template. Goes through the same
   * `useSendMessage` path as the composer's template send, so the normal
   * outbound pipeline talks to Meta — nothing here needs provider knowledge.
   * The `call_invite` metadata is kept so the thread still renders the rich
   * invite card rather than a bare template record.
   */
  const sendInviteTemplate = async (template: CallInviteTemplate, fill: InviteFill) => {
    try {
      const payload = buildTemplateSendPayload(
        { name: template.name, language: template.language, components: template.components },
        fill.values,
        fill.buttonValues,
      );
      await sendMessage.mutateAsync({
        conversationId: conversation.id,
        body: inviteTemplateBody(fill.preview, fill.deliveredLink),
        messageType: "template",
        metadata: {
          template_name: payload.name,
          template_language: payload.language,
          template_components: payload.components,
          call_invite: {
            // The URL button drops the ?exp query, so record what was sent.
            url: fill.deliveredLink,
            call_type: callType,
            expires_at: roomExpRef.current || null,
            sent_as_template: template.name,
          },
        },
      });
      setLinkSent(true);
      setTemplateOpen(false);
      toast.success(`Call invite sent to ${contactName} as "${template.name}"`);
    } catch (e) {
      toast.error("Could not send the template", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — select the link text and copy it manually.");
    }
  };

  const backToChat = () => {
    end(); // chat and call are exclusive: leaving the canvas hangs up
    onBackToChat();
  };

  return (
    <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden bg-gradient-to-b from-zinc-900 via-zinc-950 to-black text-zinc-100">
      {/* Soft brand glow behind the stage */}
      <div className="pointer-events-none absolute -top-32 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]" />

      {inCall || status === "ended" ? (
        <LiveStage
          contactName={contactName}
          avatarUrl={avatarUrl}
          initials={initials}
          status={status}
          callType={callType}
          captions={captions}
          showTranscript={showTranscript}
          localStream={localStream}
          remoteStream={remoteStream}
          cameraOff={cameraOff}
        />
      ) : (
        <SetupStage
          contactName={contactName}
          avatarUrl={avatarUrl}
          initials={initials}
          agentLocale={agentLocale}
          guestLocale={guestLocale}
          onAgentLocale={setAgentLocale}
          onGuestLocale={setGuestLocale}
          callType={callType}
          onCallType={setCallType}
          link={link}
          copied={copied}
          onCopy={() => void copyLink()}
          onSendLink={() => void sendLinkInChat()}
          sendingLink={sendMessage.isPending}
          linkSent={linkSent}
        />
      )}

      {/* Mid-call language switch */}
      {inCall && (
        <div className="relative z-10 flex items-center justify-center gap-2 px-4 pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            You
          </span>
          <Select value={agentLocale} onValueChange={setAgentLocale}>
            <SelectTrigger className={cn(darkSelectTrigger, "h-8 w-36 text-xs")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={darkSelectContent}>
              {CALL_LANGUAGES.map((l) => (
                <SelectItem key={l.locale} value={l.locale} className={darkSelectItem}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Them
          </span>
          <Select value={guestLocale} onValueChange={setGuestLocale}>
            <SelectTrigger className={cn(darkSelectTrigger, "h-8 w-36 text-xs")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={darkSelectContent}>
              {CALL_LANGUAGES.map((l) => (
                <SelectItem key={l.locale} value={l.locale} className={darkSelectItem}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Floating glass control bar */}
      <div className="relative z-10 flex items-center justify-center gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-4 sm:pb-5">
        {/*
         * Wraps rather than shrinks: at 375px the icons plus the start-call
         * pill are wider than the screen, and a plain nowrap row squeezed every
         * button out of its circle and broke the pill's label over two lines.
         */}
        <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-3xl border border-white/10 bg-white/5 px-2 py-2 shadow-2xl backdrop-blur-xl sm:gap-2 sm:rounded-full sm:px-3">
          <ControlButton
            label="Back to chat (ends the call)"
            onClick={backToChat}
            icon={<ArrowLeft className="h-5 w-5" />}
          />
          {!inCall && (
            <>
              <ControlButton
                label={
                  ringMuted
                    ? "Incoming-call ringtone muted — tap to unmute"
                    : "Incoming-call ringtone on — tap to mute"
                }
                active={ringMuted}
                onClick={toggleRingMuted}
                icon={ringMuted ? <BellOff className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
              />
              <ControlButton
                label="Call history with this contact"
                onClick={() => setHistoryOpen(true)}
                icon={<History className="h-5 w-5" />}
              />
              {/* Only shown where push is actually usable: a supported browser
                  on an install that has VAPID keys configured. */}
              {push.supported && (
                <ControlButton
                  label={
                    push.enabled
                      ? "Call alerts on this device — tap to turn off"
                      : "Get call alerts even when this tab is closed"
                  }
                  active={push.enabled}
                  onClick={() => void (push.enabled ? push.disable() : push.enable())}
                  icon={
                    push.busy ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : push.enabled ? (
                      <BellRing className="h-5 w-5" />
                    ) : (
                      <Smartphone className="h-5 w-5" />
                    )
                  }
                />
              )}
            </>
          )}
          {status === "waiting" && (
            <ControlButton
              label={linkSent ? "Call link sent — send again" : "Send the call link in chat"}
              active={linkSent}
              onClick={() => void sendLinkInChat()}
              icon={
                sendMessage.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )
              }
            />
          )}
          {inCall && (
            <>
              <ControlButton
                label={muted ? "Unmute" : "Mute"}
                active={muted}
                onClick={toggleMute}
                icon={muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              />
              {callType === "video" && (
                <ControlButton
                  label={cameraOff ? "Turn camera on" : "Turn camera off"}
                  active={cameraOff}
                  onClick={toggleCamera}
                  icon={
                    cameraOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />
                  }
                />
              )}
              <ControlButton
                label={voiceOn ? "Voice translation on — tap to mute it" : "Voice translation off"}
                active={!voiceOn}
                onClick={toggleVoice}
                icon={voiceOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
              />
              {status === "live" && (
                <ControlButton
                  label={recordingOn ? "Stop recording" : "Record the call (both voices)"}
                  active={recordingOn}
                  onClick={toggleRecording}
                  icon={
                    <CircleDot
                      className={cn("h-5 w-5", recordingOn && "animate-pulse text-red-500")}
                    />
                  }
                />
              )}
              <ControlButton
                label={showTranscript ? "Hide transcript" : "Show transcript"}
                active={showTranscript}
                onClick={() => setShowTranscript((v) => !v)}
                icon={<Captions className="h-5 w-5" />}
              />
            </>
          )}
          {status === "ended" && hasTranscript && (
            <>
              <ControlButton
                label="Download transcript (.txt)"
                onClick={() => downloadCallTranscript(callLogInput(), lastSummaryRef.current)}
                icon={<Download className="h-5 w-5" />}
              />
              <ControlButton
                label="Create a follow-up task from this call"
                onClick={() => setCreateTaskOpen(true)}
                icon={<CheckSquare className="h-5 w-5" />}
              />
            </>
          )}
          {inCall ? (
            <button
              type="button"
              onClick={end}
              title="End call"
              aria-label="End call"
              className="flex h-11 w-14 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition hover:bg-red-500 active:scale-95"
            >
              <PhoneOff className="h-5 w-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              className="flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-green-600 px-5 text-sm font-semibold text-white shadow-lg transition hover:bg-green-500 active:scale-95 sm:px-6"
            >
              <Phone className="h-4 w-4" />
              {status === "ended"
                ? "Call again"
                : callType === "video"
                  ? "Start video call"
                  : "Start voice call"}
            </button>
          )}
        </div>
      </div>

      <CreateTaskDialog
        open={createTaskOpen}
        onOpenChange={setCreateTaskOpen}
        conversation={conversation}
      />
      <CallHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        conversationId={conversation.id}
        contactName={contactName}
      />
      <CallInviteTemplateDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        templates={inviteContext.data?.templates ?? []}
        loading={inviteContext.isLoading}
        link={link}
        contactName={contactName}
        lastInboundAt={inviteContext.data?.lastInboundAt ?? null}
        onSend={(t, f) => void sendInviteTemplate(t, f)}
        sending={sendMessage.isPending}
      />
    </div>
  );
}

/* ----------------------------- Call history ------------------------------ */

type CallHistoryEntry = { id: string; created_at: string; call: TranslatedCallMeta };

/**
 * Picker shown when WhatsApp's 24-hour window has closed.
 *
 * Meta only accepts an approved template at that point, and a template can
 * only carry the call link through a dynamic URL button or a body
 * placeholder — so the list is already filtered to templates that can
 * actually deliver one, and each is previewed exactly as the customer will
 * read it before anything is sent.
 */
function CallInviteTemplateDialog({
  open,
  onOpenChange,
  templates,
  loading,
  link,
  contactName,
  lastInboundAt,
  onSend,
  sending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  templates: CallInviteTemplate[];
  loading: boolean;
  link: string;
  contactName: string;
  lastInboundAt: string | null;
  onSend: (template: CallInviteTemplate, fill: InviteFill) => void;
  sending: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = templates.find((t) => t.id === selectedId) ?? templates[0] ?? null;
  const fill = selected ? fillInviteTemplate(selected, link, contactName) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send the call link as a template</DialogTitle>
          <DialogDescription>
            {contactName} last replied{" "}
            {lastInboundAt
              ? `on ${new Date(lastInboundAt).toLocaleString()}`
              : "never in this conversation"}
            , so WhatsApp&apos;s 24-hour window is closed. Only an approved template can reach them
            now.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading approved templates…
          </div>
        ) : templates.length === 0 ? (
          <div className="space-y-2 py-4 text-sm">
            <p className="font-medium">No usable template yet</p>
            <p className="text-muted-foreground">
              A call invite needs an approved template with either a dynamic URL button or a
              placeholder in the message body to hold the link. Create one under Templates and
              submit it to Meta for approval — then this call link can be sent any time.
            </p>
            <p className="text-muted-foreground">
              In the meantime you can copy the link and send it another way.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <Select value={selected?.id ?? ""} onValueChange={setSelectedId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.language}){t.urlButtonIndex !== null ? " · button" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {fill && (
              <>
                <div className="rounded-control border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                  {fill.preview || <span className="text-muted-foreground">(empty body)</span>}
                  {selected?.urlButtonIndex !== null && (
                    <div className="mt-2 rounded border bg-background px-2 py-1 text-center text-xs font-medium text-primary">
                      Join the call
                    </div>
                  )}
                </div>
                {fill.problem && <p className="text-xs text-destructive">{fill.problem}</p>}
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!selected || Boolean(fill?.problem) || sending}
                onClick={() => selected && fill && onSend(selected, fill)}
              >
                {sending ? "Sending…" : "Send template"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CallHistoryDialog({
  open,
  onOpenChange,
  conversationId,
  contactName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contactName: string;
}) {
  const [entries, setEntries] = useState<CallHistoryEntry[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEntries(null);
    void (async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id,created_at,metadata")
        .eq("conversation_id", conversationId)
        .eq("message_type", "system")
        .order("created_at", { ascending: false })
        .limit(200);
      if (cancelled) return;
      if (error) {
        toast.error("Could not load the call history", { description: error.message });
        setEntries([]);
        return;
      }
      setEntries(
        (data ?? [])
          .map((row) => ({
            id: row.id as string,
            created_at: row.created_at as string,
            call: readTranslatedCallMeta(row.metadata),
          }))
          .filter((e): e is CallHistoryEntry => !!e.call)
          .slice(0, 50),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, conversationId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Call history with {contactName}
          </DialogTitle>
          <DialogDescription>
            Every saved translated call in this conversation, newest first.
          </DialogDescription>
        </DialogHeader>
        {entries === null ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No calls with {contactName} yet.
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {entries.map((e) => {
              const isVideo = e.call.call_type === "video";
              const Icon = isVideo ? Video : Phone;
              return (
                <div key={e.id} className="flex items-start gap-3 rounded-control bg-muted p-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">
                        {isVideo ? "Video" : "Voice"} call ·{" "}
                        {formatCallDuration(e.call.duration_sec ?? 0)}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {new Date(e.created_at).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                    </div>
                    {e.call.summary && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {e.call.summary}
                      </p>
                    )}
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {(e.call.lines ?? []).length} transcript lines
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ Setup stage ------------------------------ */

function SetupStage(props: {
  contactName: string;
  avatarUrl?: string | null;
  initials: string;
  agentLocale: string;
  guestLocale: string;
  onAgentLocale: (v: string) => void;
  onGuestLocale: (v: string) => void;
  callType: "voice" | "video";
  onCallType: (v: "voice" | "video") => void;
  link: string;
  copied: boolean;
  onCopy: () => void;
  onSendLink: () => void;
  sendingLink: boolean;
  linkSent: boolean;
}) {
  const {
    contactName,
    avatarUrl,
    initials,
    agentLocale,
    guestLocale,
    onAgentLocale,
    onGuestLocale,
    callType,
    onCallType,
    link,
    copied,
    onCopy,
    onSendLink,
    sendingLink,
    linkSent,
  } = props;
  /*
   * justify-center with overflow-y-auto clips the top of the content once it
   * is taller than the box — on a phone the avatar sat right under the header
   * with nothing above it and no way to scroll up. Centre only when there is
   * room for it.
   */
  return (
    <div className="relative z-10 flex flex-1 min-h-0 flex-col items-center justify-start gap-4 overflow-y-auto px-4 py-5 sm:justify-center sm:gap-5 sm:px-6 sm:py-8">
      <Avatar className="h-20 w-20 ring-4 ring-white/10 shadow-2xl">
        {avatarUrl && <AvatarImage src={avatarUrl} alt={contactName} />}
        <AvatarFallback className="bg-primary/20 text-xl font-semibold text-white">
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className="text-center">
        <h2 className="text-xl font-semibold text-white">{contactName}</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Translated call — you each speak your own language
        </p>
      </div>

      {/* Call type */}
      <div className="flex gap-2 rounded-full border border-white/10 bg-white/5 p-1">
        {(
          [
            { id: "voice", label: "Voice", icon: <Phone className="h-4 w-4" /> },
            { id: "video", label: "Video", icon: <Video className="h-4 w-4" /> },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onCallType(t.id)}
            className={cn(
              "flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition",
              callType === t.id
                ? "bg-white text-zinc-900 shadow"
                : "text-zinc-300 hover:bg-white/10",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Languages */}
      <div className="grid w-full max-w-md grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs text-zinc-400">You speak</label>
          <Select value={agentLocale} onValueChange={onAgentLocale}>
            <SelectTrigger className={darkSelectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={darkSelectContent}>
              {CALL_LANGUAGES.map((l) => (
                <SelectItem key={l.locale} value={l.locale} className={darkSelectItem}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-zinc-400">{contactName} speaks</label>
          <Select value={guestLocale} onValueChange={onGuestLocale}>
            <SelectTrigger className={darkSelectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={darkSelectContent}>
              {CALL_LANGUAGES.map((l) => (
                <SelectItem key={l.locale} value={l.locale} className={darkSelectItem}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Invite link */}
      <div className="w-full max-w-md space-y-2">
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Link2 className="h-3.5 w-3.5" /> {contactName} joins from this link — no app or account
          needed on their side
        </label>
        <Button
          type="button"
          onClick={onSendLink}
          disabled={sendingLink}
          className={cn(
            "w-full gap-2",
            linkSent && "!bg-green-600/20 !text-green-400 hover:!bg-green-600/30",
          )}
        >
          {sendingLink ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : linkSent ? (
            <Check className="h-4 w-4" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {linkSent ? `Link sent to ${contactName} — send again?` : "Send call link in chat"}
        </Button>
        <div className="flex gap-2">
          <Input
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
            className="!border-zinc-700 !bg-zinc-900/90 text-xs !text-zinc-200 !shadow-none focus-visible:!ring-zinc-600"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onCopy}
            className="!border-zinc-700 !bg-zinc-900/90 !text-zinc-200 !shadow-none hover:!bg-zinc-800 hover:!text-white"
          >
            {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Live stage ------------------------------ */

function LiveStage(props: {
  contactName: string;
  avatarUrl?: string | null;
  initials: string;
  status: "waiting" | "connecting" | "live" | "ended" | "idle";
  callType: "voice" | "video";
  captions: {
    id: string;
    who: "agent" | "guest";
    original: string;
    translated: string;
    final: boolean;
  }[];
  showTranscript: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  cameraOff: boolean;
}) {
  const {
    contactName,
    avatarUrl,
    initials,
    status,
    callType,
    captions,
    showTranscript,
    localStream,
    remoteStream,
    cameraOff,
  } = props;
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const hasRemoteVideo = callType === "video" && !!remoteStream?.getVideoTracks().length;

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);
  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream]);
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [captions]);

  // Call timer, from the moment audio goes live.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status !== "live") return;
    const startedAt = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [status]);
  const timer = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  // If nobody has joined after a while, the most likely explanation is a
  // stale link (e.g. one sent before this call was restarted) — nudge
  // towards resending rather than leaving the spinner unexplained.
  const [waitingLong, setWaitingLong] = useState(false);
  useEffect(() => {
    setWaitingLong(false);
    if (status !== "waiting") return;
    const t = setTimeout(() => setWaitingLong(true), 20_000);
    return () => clearTimeout(t);
  }, [status]);

  // Subtitle overlay: the last caption from each side.
  const lastGuest = [...captions].reverse().find((c) => c.who === "guest");
  const lastAgent = [...captions].reverse().find((c) => c.who === "agent");

  return (
    <div className="relative z-10 flex flex-1 min-h-0">
      {/* Stage */}
      <div className="relative flex flex-1 min-w-0 flex-col items-center justify-center">
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
          <div className="flex flex-col items-center gap-5">
            <div className="relative">
              {status === "live" && (
                <>
                  <span className="absolute inset-0 -m-4 animate-ping rounded-full bg-primary/20" />
                  <span className="absolute inset-0 -m-8 animate-pulse rounded-full bg-primary/10" />
                </>
              )}
              <Avatar className="relative h-28 w-28 ring-4 ring-white/10 shadow-2xl">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={contactName} />}
                <AvatarFallback className="bg-primary/20 text-3xl font-semibold text-white">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </div>
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-white">{contactName}</h2>
              <p className="mt-1 flex items-center justify-center gap-2 text-sm text-zinc-400">
                {status === "waiting" && (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for them to open the
                    call link…
                  </>
                )}
                {status === "connecting" && (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…
                  </>
                )}
                {status === "live" && (
                  <>
                    <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" /> {timer}
                  </>
                )}
                {status === "ended" && "Call ended"}
              </p>
              {status === "waiting" && waitingLong && (
                <p className="mt-2 max-w-xs text-xs text-zinc-500">
                  Still nothing after a while? They may have an older link from a previous attempt —
                  tap "Send the call link" below to send a fresh one.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Video-call status chip */}
        {hasRemoteVideo && (
          <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs text-white backdrop-blur">
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            {contactName} · {timer}
          </div>
        )}

        {/* Local preview */}
        {callType === "video" && localStream && (
          <div className="absolute bottom-4 right-4 h-28 w-44 overflow-hidden rounded-xl border border-white/15 bg-black/60 shadow-2xl">
            {cameraOff ? (
              <div className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
                <VideoOff className="mr-1.5 h-4 w-4" /> Camera off
              </div>
            ) : (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full scale-x-[-1] object-cover"
              />
            )}
          </div>
        )}

        {/* Subtitle overlay */}
        {(lastGuest || lastAgent) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex flex-col items-center gap-1.5 px-6">
            {lastGuest && (
              <p className="max-w-2xl rounded-xl bg-black/60 px-4 py-2 text-center text-sm text-white backdrop-blur">
                <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                  {contactName}
                </span>
                {lastGuest.translated || lastGuest.original}
              </p>
            )}
            {lastAgent && (
              <p className="max-w-2xl rounded-xl bg-black/40 px-4 py-1.5 text-center text-xs text-zinc-300 backdrop-blur">
                <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-green-400">
                  You
                </span>
                {lastAgent.original}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Transcript rail */}
      {showTranscript && (
        <div className="hidden w-80 shrink-0 flex-col border-l border-white/10 bg-black/40 backdrop-blur-xl sm:flex">
          <div className="border-b border-white/10 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Live transcript
          </div>
          <div ref={transcriptRef} className="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
            {captions.length === 0 && (
              <p className="pt-10 text-center text-xs text-zinc-500">
                Captions appear here as you both talk.
              </p>
            )}
            {captions.map((c) => (
              <div key={c.id} className={cn("flex", c.who === "agent" && "justify-end")}>
                <div
                  className={cn(
                    "max-w-[90%] rounded-lg px-3 py-1.5",
                    c.who === "agent" ? "bg-primary/20 text-right" : "bg-white/10",
                    !c.final && "opacity-60",
                  )}
                >
                  <div className="text-zinc-100">
                    {c.who === "guest" ? c.translated || c.original : c.original}
                  </div>
                  {c.who === "guest" && c.translated && c.original !== c.translated && (
                    <div className="mt-0.5 text-[11px] text-zinc-400">{c.original}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Controls ------------------------------- */

function ControlButton({
  label,
  icon,
  onClick,
  active,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition active:scale-95",
        active ? "bg-white text-zinc-900 shadow" : "bg-white/10 text-white hover:bg-white/20",
      )}
    >
      {icon}
    </button>
  );
}

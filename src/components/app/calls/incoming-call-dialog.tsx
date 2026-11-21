/**
 * The incoming-call modal.
 *
 * Mounted once in the authenticated layout, so a call rings wherever the agent
 * happens to be — dashboard, contacts, CRM — not only on the inbox page where
 * the old toast lived.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare, Phone, PhoneOff, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { supabase } from "@/integrations/supabase/client";
import {
  resolveContactDisplayName,
  resolveContactInitials,
  type PartialContactLike,
} from "@/lib/inbox/contact-display";
import { useIncomingCalls, type IncomingCall } from "@/hooks/use-incoming-call-alert";

/** How long the caller has been waiting, as a live "0:07". */
function useElapsed(since: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Who is calling. The alert only carries a conversation id, so the name is
 * looked up here; until it resolves the dialog still shows and still rings,
 * because a nameless call is far better than a late one.
 */
function useCaller(conversationId: string): PartialContactLike | null {
  const [row, setRow] = useState<PartialContactLike | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("id", conversationId)
        .maybeSingle();
      if (cancelled || !data) return;
      setRow(data as unknown as PartialContactLike);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);
  return row;
}

function IncomingCallBody({
  call,
  muted,
  onMutedChange,
  onAnswer,
  onDecline,
  onOpenConversation,
}: {
  call: IncomingCall;
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  onAnswer: () => void;
  onDecline: () => void;
  onOpenConversation: () => void;
}) {
  const elapsed = useElapsed(call.startedAt);
  const caller = useCaller(call.conversationId);
  const label = caller ? resolveContactDisplayName(caller) : "Customer";

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/70" />
            <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
          </span>
          Incoming call
        </DialogTitle>
        <DialogDescription>The customer opened your call link and is waiting.</DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-4 py-2">
        <Avatar className="size-14">
          <AvatarFallback>{caller ? resolveContactInitials(caller) : "?"}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">{label}</p>
          <p className="text-sm text-muted-foreground tabular-nums">Ringing {elapsed}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto shrink-0"
          aria-label={muted ? "Unmute ringtone" : "Mute ringtone"}
          title={muted ? "Unmute ringtone" : "Mute ringtone"}
          onClick={() => onMutedChange(!muted)}
        >
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" className="flex-1" onClick={onAnswer}>
          <Phone className="size-4" /> Answer
        </Button>
        <Button type="button" variant="destructive" className="flex-1" onClick={onDecline}>
          <PhoneOff className="size-4" /> Decline
        </Button>
      </div>
      <Button type="button" variant="outline" className="w-full" onClick={onOpenConversation}>
        <MessageSquare className="size-4" /> Open conversation
      </Button>
    </>
  );
}

export function IncomingCallDialog() {
  const { calls, answer, decline, dismiss, muted, setMuted } = useIncomingCalls();
  const navigate = useNavigate();
  // Two guests at once is possible; ring for the oldest and queue the rest.
  const call = calls[0];

  if (!call) return null;

  const goToInbox = (search: Record<string, string>) =>
    void navigate({ to: "/inbox", search: search as never });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Closing with Escape or the backdrop is not a decline — the agent may
        // be walking to a quieter room. Stop the ring, keep the thread clean.
        if (!next) dismiss(call);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <IncomingCallBody
          call={call}
          muted={muted}
          onMutedChange={setMuted}
          onAnswer={() => {
            // The inbox answers in place when it is mounted; from any other
            // page, hand the call over through its deep link.
            if (!answer(call)) goToInbox({ call: call.conversationId });
          }}
          onDecline={() => decline(call)}
          onOpenConversation={() => {
            dismiss(call);
            goToInbox({ conversationId: call.conversationId });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

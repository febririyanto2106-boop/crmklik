import { useState } from "react";
import { ArrowLeftRight, Download, FileText, PhoneCall, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { callLanguage } from "@/lib/calls/translated-call";
import { formatCallDuration } from "@/lib/calls/call-log";

/** The structured call record saved in `metadata.translated_call`. */
export type TranslatedCallMeta = {
  contact_name?: string;
  call_type?: "voice" | "video";
  duration_sec?: number;
  agent_locale?: string;
  guest_locale?: string;
  summary?: string | null;
  lines?: Array<{ who?: "agent" | "guest"; original?: string; translated?: string | null }>;
  /** Set by the retention sweep once the spoken lines have been stripped. */
  transcript_purged_at?: string | null;
};

export function readTranslatedCallMeta(metadata: unknown): TranslatedCallMeta | null {
  const md = metadata as Record<string, unknown> | null | undefined;
  const tc = md?.translated_call;
  return tc && typeof tc === "object" ? (tc as TranslatedCallMeta) : null;
}

/** The invite details saved in `metadata.call_invite` when a link is sent. */
export type CallInviteMeta = {
  url?: string;
  call_type?: "voice" | "video";
  expires_at?: number | null;
};

export function readCallInviteMeta(metadata: unknown): CallInviteMeta | null {
  const md = metadata as Record<string, unknown> | null | undefined;
  const ci = md?.call_invite;
  return ci && typeof ci === "object" && (ci as CallInviteMeta).url ? (ci as CallInviteMeta) : null;
}

/**
 * A sent call invitation, rendered as a rich bubble: who invited, the
 * message itself, and a link-preview-style card that joins the call on
 * click — instead of a bare autolinked URL.
 */
export function CallInviteBubble({
  invite,
  body,
  senderName,
  senderAvatarUrl,
  isOwn,
}: {
  invite: CallInviteMeta;
  body: string | null;
  senderName: string;
  senderAvatarUrl?: string | null;
  isOwn: boolean;
}) {
  const isVideo = invite.call_type === "video";
  const Icon = isVideo ? Video : PhoneCall;
  const expired = typeof invite.expires_at === "number" && invite.expires_at < Date.now();
  // The URL is repeated by the preview card below — strip it from the text.
  const text = (body ?? "")
    .replace(invite.url ?? "", "")
    .trim()
    .replace(/:\s*$/, ".");
  let host = "";
  try {
    host = new URL(invite.url!).host;
  } catch {
    host = invite.url ?? "";
  }

  return (
    <div className="min-w-[240px] max-w-[340px] space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full text-[10px] font-semibold",
            isOwn ? "bg-primary-foreground/20" : "bg-primary/10 text-primary",
          )}
        >
          {senderAvatarUrl ? (
            <img src={senderAvatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            senderName
              .split(" ")
              .map((w) => w[0])
              .filter(Boolean)
              .slice(0, 2)
              .join("")
              .toUpperCase() || "?"
          )}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-xs font-semibold">{senderName}</div>
          <div className="text-[10px] uppercase tracking-wide opacity-70">
            {isVideo ? "Video" : "Voice"} call invitation
          </div>
        </div>
      </div>

      {text && <p className="text-sm leading-relaxed">{text}</p>}

      <a
        href={expired ? undefined : invite.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={(e) => {
          e.stopPropagation();
          if (expired) e.preventDefault();
        }}
        aria-disabled={expired}
        className={cn(
          "flex items-center gap-3 rounded-control p-2.5 transition-opacity",
          isOwn ? "bg-primary-foreground/15" : "bg-primary/10",
          expired ? "cursor-default opacity-60" : "hover:opacity-85",
        )}
      >
        <span
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-control",
            isOwn ? "bg-primary-foreground/20" : "bg-background text-primary",
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {expired ? "Call link expired" : `Join the ${isVideo ? "video" : "voice"} call`}
          </span>
          <span className="block truncate text-[11px] opacity-75">
            {expired
              ? "Send a fresh link to call again"
              : "Opens in the browser — no app or account needed"}
          </span>
          <span className="mt-0.5 block truncate text-[10px] opacity-60">{host}</span>
        </span>
      </a>
    </div>
  );
}

/**
 * A finished translated call in the chat history. A long call can carry
 * hundreds of transcript lines — those stay behind a "View transcript"
 * dialog (with a .txt download) instead of flooding the thread; the bubble
 * itself is a compact card: icon, duration, languages, and the AI summary.
 */
export function TranslatedCallLogCard({
  call,
  contactName,
  isOwn,
  recordingUrl,
  recordingPurged,
}: {
  call: TranslatedCallMeta;
  contactName: string;
  isOwn: boolean;
  /** Signed URL of the saved call recording, when one was made. */
  recordingUrl?: string | null;
  /** True when the retention sweep has deleted the audio file. */
  recordingPurged?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const transcriptPurged = Boolean(call.transcript_purged_at);
  const isVideo = call.call_type === "video";
  const Icon = isVideo ? Video : PhoneCall;
  const agentLang = callLanguage(call.agent_locale ?? "");
  const guestLang = callLanguage(call.guest_locale ?? "");
  const lines = (call.lines ?? []).filter((l) => l.original);

  const transcriptText = () =>
    [
      `Translated ${isVideo ? "video" : "voice"} call with ${contactName}`,
      `Duration ${formatCallDuration(call.duration_sec ?? 0)} · Agent: ${agentLang.label} · ${contactName}: ${guestLang.label}`,
      ...(call.summary ? ["", `Summary: ${call.summary}`] : []),
      "",
      "Transcript:",
      ...(lines.length
        ? lines.map((l) => {
            const speaker = l.who === "agent" ? "Agent" : contactName;
            const tr = l.translated && l.translated !== l.original ? ` ⇄ ${l.translated}` : "";
            return `${speaker}: ${l.original}${tr}`;
          })
        : ["(no speech was recognized)"]),
    ].join("\n");

  const download = () => {
    const blob = new Blob([transcriptText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `call-transcript-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-w-[240px] max-w-[320px]">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full",
            isOwn ? "bg-primary-foreground/20" : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">
            Translated {isVideo ? "video" : "voice"} call
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] opacity-80">
            <span>{formatCallDuration(call.duration_sec ?? 0)}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-0.5 truncate">
              {agentLang.label} <ArrowLeftRight className="h-2.5 w-2.5 shrink-0" />{" "}
              {guestLang.label}
            </span>
          </div>
        </div>
      </div>

      {call.summary && (
        <p className="mt-2 line-clamp-3 text-xs leading-relaxed opacity-90">{call.summary}</p>
      )}

      {recordingUrl && (
        <audio
          controls
          src={recordingUrl}
          preload="metadata"
          className="mt-2 h-9 w-full"
          aria-label="Call recording"
        />
      )}

      {lines.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-control px-3 py-1.5 text-xs font-medium transition-colors",
            isOwn
              ? "bg-primary-foreground/15 hover:bg-primary-foreground/25"
              : "bg-primary/10 text-primary hover:bg-primary/15",
          )}
        >
          <FileText className="h-3.5 w-3.5" />
          View transcript ({lines.length} lines)
        </button>
      )}

      {/* Retention has removed the content. Say so plainly rather than
          rendering an empty card that looks like the call failed to save. */}
      {(recordingPurged || transcriptPurged) && (
        <p className="mt-2 text-[11px] italic opacity-60">
          {recordingPurged && transcriptPurged
            ? "Recording and transcript removed by the retention policy."
            : recordingPurged
              ? "Recording removed by the retention policy."
              : "Transcript removed by the retention policy."}
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              Translated {isVideo ? "video" : "voice"} call with {contactName}
            </DialogTitle>
            <DialogDescription>
              {formatCallDuration(call.duration_sec ?? 0)} · Agent: {agentLang.label} ·{" "}
              {contactName}: {guestLang.label}
            </DialogDescription>
          </DialogHeader>
          {call.summary && (
            <div className="rounded-control bg-muted px-3 py-2 text-sm">
              <span className="font-medium">Summary: </span>
              {call.summary}
            </div>
          )}
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {lines.map((l, i) => {
              const fromAgent = l.who === "agent";
              return (
                <div key={i} className={cn("flex", fromAgent ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[85%] rounded-control px-3 py-1.5 text-sm",
                      fromAgent ? "bg-primary/10" : "bg-muted",
                    )}
                  >
                    <div className="text-[10px] font-medium uppercase tracking-wide opacity-60">
                      {fromAgent ? "Agent" : contactName}
                    </div>
                    <div>{l.original}</div>
                    {l.translated && l.translated !== l.original && (
                      <div className="mt-0.5 text-xs text-muted-foreground">{l.translated}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={download}>
              <Download className="h-4 w-4" /> Download .txt
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

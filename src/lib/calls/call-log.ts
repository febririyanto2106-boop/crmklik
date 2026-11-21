/**
 * Saving a finished translated call into the conversation it belongs to.
 *
 * The call itself is ephemeral (nothing is stored while it runs); when it
 * ends, the agent's side writes one `system` message into the conversation
 * carrying the AI summary and the full bilingual transcript. That makes the
 * call part of the normal chat history: it shows in the thread, survives in
 * the record, and rides along in the existing "Export transcript" feature
 * for free. A `metadata.translated_call` block keeps the structured form
 * for anything that wants more than text later.
 */
import { supabase } from "@/integrations/supabase/client";
import { aiChat } from "@/lib/ai/complete.functions";
import { callLanguage, type CaptionEntry } from "@/lib/calls/translated-call";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sbAny = (c: unknown) => c as any;

export type CallLogInput = {
  workspaceId: string;
  conversationId: string;
  contactName: string;
  callType: "voice" | "video";
  durationSec: number;
  agentLocale: string;
  guestLocale: string;
  captions: CaptionEntry[];
};

export function formatCallDuration(sec: number) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/** The transcript as plain text — used for the chat note and the download. */
export function buildCallTranscriptText(input: CallLogInput, summary: string | null) {
  const agentLang = callLanguage(input.agentLocale);
  const guestLang = callLanguage(input.guestLocale);
  const lines = input.captions
    .filter((c) => c.final && c.original)
    .map((c) => {
      const speaker = c.who === "agent" ? "Agent" : input.contactName;
      const translation = c.translated && c.translated !== c.original ? ` ⇄ ${c.translated}` : "";
      return `${speaker}: ${c.original}${translation}`;
    });
  return [
    `📞 Translated ${input.callType} call with ${input.contactName}`,
    `Duration ${formatCallDuration(input.durationSec)} · Agent: ${agentLang.label} · ${input.contactName}: ${guestLang.label}`,
    ...(summary ? ["", `Summary: ${summary}`] : []),
    "",
    "Transcript:",
    ...(lines.length ? lines : ["(no speech was recognized)"]),
  ].join("\n");
}

/** Best-effort AI summary of the call via the workspace's AI gateway. */
export async function summarizeCall(input: CallLogInput): Promise<string | null> {
  const lines = input.captions
    .filter((c) => c.final && c.original)
    .map((c) => `${c.who === "agent" ? "Agent" : "Customer"}: ${c.translated || c.original}`);
  if (lines.length < 2) return null;
  try {
    const res = await aiChat({
      data: {
        messages: [
          {
            role: "user",
            content:
              "Summarize this customer call in 2-3 short sentences: what was discussed, " +
              "any decisions, and any follow-up the agent should do. Reply with the summary only.\n\n" +
              lines.join("\n"),
          },
        ],
        max_tokens: 200,
      },
    });
    return res.content?.trim() || null;
  } catch {
    return null; // a failed summary never blocks saving the transcript
  }
}

/**
 * The short text stored as the message body. The full transcript lives only
 * in `metadata.translated_call` — the chat renders it behind a "View
 * transcript" dialog, so a long call never floods the thread as one huge
 * text bubble. The body stays short because it is also what the conversation
 * list preview and plain-text exports show.
 */
export function buildCallNoteText(input: CallLogInput, summary: string | null) {
  const head = `Translated ${input.callType} call with ${input.contactName} · ${formatCallDuration(input.durationSec)}`;
  return summary ? `${head}\nSummary: ${summary}` : head;
}

/** An uploaded call-recording file, as `uploadAttachment` returns it. */
export type CallRecordingUpload = { url: string; size: number; type: string; path: string };

/** Write the call note into the conversation's message history. */
export async function saveCallLogToConversation(
  input: CallLogInput,
  summary: string | null,
  recording: CallRecordingUpload | null = null,
) {
  const { data: auth } = await supabase.auth.getUser();
  const body = buildCallNoteText(input, summary);
  const { error } = await sbAny(supabase)
    .from("messages")
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      direction: "outbound",
      message_type: "system",
      status: "sent",
      body,
      sent_by: auth.user?.id ?? null,
      // The bubble resolves playback/download from `metadata.media_path`
      // (signed on demand), the same way ordinary audio attachments work.
      media_url: recording?.url ?? null,
      media_type: recording ? recording.type || "audio/webm" : null,
      media_size: recording?.size ?? null,
      metadata: {
        ...(recording ? { media_path: recording.path, media_name: "call-recording.webm" } : {}),
        translated_call: {
          contact_name: input.contactName,
          call_type: input.callType,
          duration_sec: input.durationSec,
          agent_locale: input.agentLocale,
          guest_locale: input.guestLocale,
          summary,
          lines: input.captions
            .filter((c) => c.final && c.original)
            .map((c) => ({ who: c.who, original: c.original, translated: c.translated })),
        },
      },
    });
  if (error) throw new Error(error.message ?? "Could not save the call to the conversation");
}

/** Offer the transcript as a .txt download in the browser. */
export function downloadCallTranscript(input: CallLogInput, summary: string | null) {
  const blob = new Blob([buildCallTranscriptText(input, summary)], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `call-transcript-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

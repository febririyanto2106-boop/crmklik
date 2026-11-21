/**
 * Call invites outside WhatsApp's 24-hour window.
 *
 * WhatsApp only allows free-form messages for 24 hours after the customer's
 * last inbound message. Past that, the plain-text call link is rejected by
 * Meta (error 131047) and the customer never learns a call is waiting — the
 * agent just sees a failed message.
 *
 * This reports whether the window is open and, when it is not, which of the
 * workspace's APPROVED templates can actually carry a call link. The send
 * itself reuses the normal outbound pipeline (a `template` message), so
 * nothing new has to know how to talk to Meta.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sbAny } from "@/lib/supabase/untyped";
import type { TemplateComponent } from "@/lib/messaging/template-send-payload";

/** Meta's customer-service window. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CallInviteTemplate = {
  id: string;
  name: string;
  language: string;
  category: string | null;
  /** Raw stored components, as synced from Meta. */
  components: TemplateComponent[];
  /** Body text with {{n}} placeholders, for the preview. */
  bodyText: string;
  /** Placeholder numbers found in the body, ascending. */
  bodyVariables: string[];
  /**
   * Index of a dynamic URL button, if the template has one. Meta only allows
   * the URL *suffix* to vary, so such a template carries the link far more
   * cleanly than pasting it into the body.
   */
  urlButtonIndex: number | null;
  /** The fixed part of that button's URL, e.g. "https://app.example.com/call/". */
  urlButtonBase: string | null;
  /** The placeholder number inside that button URL, e.g. "1". */
  urlButtonVariable: string | null;
};

export type CallInviteContext = {
  /** Null when the channel has no 24-hour rule (or there is no inbound yet). */
  insideWindow: boolean;
  lastInboundAt: string | null;
  /** Milliseconds left in the window; 0 when closed. */
  msRemaining: number;
  /** Only meaningful for WhatsApp conversations. */
  isWhatsApp: boolean;
  templates: CallInviteTemplate[];
};

function placeholders(text: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]!);
  return [...out].sort((a, b) => Number(a) - Number(b));
}

/**
 * A template can carry a call link if it has a dynamic URL button, or at least
 * one body placeholder to paste the link into. Anything else would send the
 * customer a message with no way to join.
 */
function toInviteTemplate(row: {
  id: string;
  name: string;
  language: string | null;
  category: string | null;
  components: unknown;
}): CallInviteTemplate | null {
  const components = Array.isArray(row.components) ? (row.components as TemplateComponent[]) : [];

  let bodyText = "";
  let urlButtonIndex: number | null = null;
  let urlButtonBase: string | null = null;
  let urlButtonVariable: string | null = null;

  for (const c of components) {
    const type = String(c.type ?? "").toUpperCase();
    if (type === "BODY" && typeof c.text === "string") bodyText = c.text;
    if (type === "BUTTONS" && Array.isArray(c.buttons)) {
      const buttons = c.buttons;
      for (let i = 0; i < buttons.length; i += 1) {
        const b = buttons[i];
        const url = typeof b?.url === "string" ? b.url : "";
        if (String(b?.type ?? "").toUpperCase() === "URL" && /\{\{\s*\d+\s*\}\}/.test(url)) {
          urlButtonIndex = i;
          urlButtonBase = url.replace(/\{\{\s*\d+\s*\}\}/, "");
          break;
        }
      }
    }
  }

  const bodyVariables = placeholders(bodyText);
  if (urlButtonIndex === null && bodyVariables.length === 0) return null;

  return {
    id: row.id,
    name: row.name,
    language: row.language ?? "en_US",
    category: row.category,
    components,
    bodyText,
    bodyVariables,
    urlButtonIndex,
    urlButtonBase,
    urlButtonVariable,
  };
}

export const getCallInviteContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) => z.object({ conversationId: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }): Promise<CallInviteContext> => {
    const { data: convRaw, error: convError } = await sbAny(context.supabase)
      .from("conversations")
      .select("id, workspace_id, channel")
      .eq("id", data.conversationId)
      .maybeSingle();
    if (convError) throw new Error(convError.message);
    const conv = convRaw as { workspace_id: string; channel: string | null } | null;
    if (!conv) throw new Error("Conversation not found");

    const isWhatsApp = (conv.channel ?? "").toLowerCase().includes("whatsapp");

    const { data: lastRaw } = await sbAny(context.supabase)
      .from("messages")
      .select("created_at")
      .eq("conversation_id", data.conversationId)
      .eq("direction", "inbound")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastInboundAt = (lastRaw as { created_at: string } | null)?.created_at ?? null;

    const elapsed = lastInboundAt ? Date.now() - new Date(lastInboundAt).getTime() : Infinity;
    const msRemaining = Number.isFinite(elapsed) ? Math.max(0, WHATSAPP_WINDOW_MS - elapsed) : 0;
    // No inbound message at all means the window was never opened.
    const insideWindow = lastInboundAt !== null && msRemaining > 0;

    // Templates only matter when a template is what we will have to send.
    if (!isWhatsApp || insideWindow) {
      return { insideWindow, lastInboundAt, msRemaining, isWhatsApp, templates: [] };
    }

    const { data: rows } = await sbAny(context.supabase)
      .from("wa_templates")
      .select("id, name, language, category, status, components")
      .eq("workspace_id", conv.workspace_id)
      /*
       * Statuses are stored lower-case (see STATUS_MAP in templates.server.ts),
       * so the old `.eq("status", "APPROVED")` matched nothing and the picker
       * reported "no usable template yet" even with approved templates in the
       * workspace. Both casings are accepted in case a row was written by an
       * older sync.
       */
      .in("status", ["approved", "APPROVED"])
      .order("updated_at", { ascending: false })
      .limit(100);

    const templates = ((rows ?? []) as Array<Parameters<typeof toInviteTemplate>[0]>)
      .map(toInviteTemplate)
      .filter((t): t is CallInviteTemplate => t !== null);

    return { insideWindow, lastInboundAt, msRemaining, isWhatsApp, templates };
  });

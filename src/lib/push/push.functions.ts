/**
 * Web Push server functions: device registration, room registration, and the
 * public "a guest just joined the call" trigger.
 *
 * Push here is strictly best-effort. The existing in-tab ring + toast remains
 * the primary alert; push only extends it to a backgrounded or closed tab. No
 * failure in this file is ever allowed to break sending an invite or joining a
 * call.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sbAny } from "@/lib/supabase/untyped";

/* ------------------------------------------------------------ public key -- */

/**
 * The VAPID public key the browser needs in order to subscribe. Public by
 * design: it is an application-server identifier, not a secret. Returns null
 * when push is not configured, which the client treats as "feature off".
 */
export const getPushPublicKey = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ publicKey: string | null }> => {
    const { readVapidConfig } = await import("@/lib/push/web-push.server");
    return { publicKey: readVapidConfig()?.publicKey ?? null };
  },
);

/* ------------------------------------------------------------ device reg -- */

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  user_agent: z.string().max(500).optional(),
});

export const registerPushDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) => subscriptionSchema.parse(v))
  .handler(async ({ data, context }) => {
    const { error } = await sbAny(context.supabase)
      .from("push_subscriptions")
      .upsert(
        {
          user_id: context.userId,
          endpoint: data.endpoint,
          keys: data.keys,
          user_agent: data.user_agent ?? null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "endpoint" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const unregisterPushDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) => z.object({ endpoint: z.string().url() }).parse(v))
  .handler(async ({ data, context }) => {
    const { error } = await sbAny(context.supabase)
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", data.endpoint)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* -------------------------------------------------------------- test send -- */

export const sendTestPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sent = await pushToUser(context.userId, {
      kind: "test",
      title: "Push notifications are working",
      body: "You will be alerted here when a customer joins a call.",
      url: "/inbox",
    });
    return { sent };
  });

/* ------------------------------------------------------------ room registry */

const roomSchema = z.object({
  room_id: z.string().min(8).max(100),
  conversation_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  contact_name: z.string().max(200).optional(),
  call_type: z.enum(["voice", "video"]).default("voice"),
  expires_at: z.number().int().positive(),
});

/**
 * Called by the agent when a call link is created, so the public guest page can
 * later resolve `roomId -> host user` without the room id itself granting any
 * access to data.
 */
export const registerCallRoom = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) => roomSchema.parse(v))
  .handler(async ({ data, context }) => {
    const { error } = await sbAny(context.supabase)
      .from("call_rooms")
      .upsert(
        {
          room_id: data.room_id,
          workspace_id: data.workspace_id,
          conversation_id: data.conversation_id,
          host_user_id: context.userId,
          contact_name: data.contact_name ?? null,
          call_type: data.call_type,
          expires_at: new Date(data.expires_at).toISOString(),
          notified_at: null,
        },
        { onConflict: "room_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ------------------------------------------------------- guest join trigger */

/**
 * Public on purpose: the guest call page has no account and no session. The
 * room id is an unguessable UUID and acts as the capability. This returns only
 * `{ ok }` — never the conversation, the host, or anything else — so a guessed
 * id reveals nothing and at worst rings the agent's own phone.
 */
export const notifyIncomingCall = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ room_id: z.string().min(8).max(100) }).parse(v))
  .handler(async ({ data }) => {
    try {
      const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
      const { data: room } = await sbAny(supabaseAdmin)
        .from("call_rooms")
        .select("room_id, host_user_id, conversation_id, contact_name, call_type, expires_at")
        .eq("room_id", data.room_id)
        .maybeSingle();
      if (!room) return { ok: false };

      const r = room as {
        host_user_id: string;
        conversation_id: string;
        contact_name: string | null;
        call_type: string;
        expires_at: string;
      };
      // An expired link must not be able to ring someone indefinitely.
      if (new Date(r.expires_at).getTime() < Date.now()) return { ok: false };

      const who = r.contact_name || "A customer";
      await pushToUser(r.host_user_id, {
        kind: "incoming_call",
        title: `Incoming ${r.call_type} call`,
        body: `${who} is waiting on the call link.`,
        url: `/inbox?call=${r.conversation_id}`,
        conversationId: r.conversation_id,
      });

      await sbAny(supabaseAdmin)
        .from("call_rooms")
        .update({ notified_at: new Date().toISOString() })
        .eq("room_id", data.room_id);

      return { ok: true };
    } catch {
      // Push is an enhancement; joining the call must still work.
      return { ok: false };
    }
  });

/* ---------------------------------------------------------------- fan-out -- */

export type PushPayload = {
  kind: string;
  title: string;
  body: string;
  url: string;
  conversationId?: string;
};

/**
 * Sends one payload to every device the user has registered, pruning any the
 * push service reports as revoked. Returns how many were delivered.
 */
export async function pushToUser(userId: string, payload: PushPayload): Promise<number> {
  const { sendWebPush, readVapidConfig } = await import("@/lib/push/web-push.server");
  if (!readVapidConfig()) return 0;

  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data: subs } = await sbAny(supabaseAdmin)
    .from("push_subscriptions")
    .select("endpoint, keys")
    .eq("user_id", userId);
  if (!subs?.length) return 0;

  const targets = subs as { endpoint: string; keys: { p256dh: string; auth: string } }[];
  const results = await Promise.all(
    targets.map((s) =>
      sendWebPush(
        { endpoint: s.endpoint, keys: s.keys },
        payload,
        // A call alert is worthless if it arrives late: ask for immediate
        // delivery and let it expire quickly rather than ring after hang-up.
        payload.kind === "incoming_call"
          ? { urgency: "high", ttl: 45 }
          : { urgency: "normal", ttl: 300 },
      ),
    ),
  );

  const dead = targets.filter((_, i) => results[i].gone).map((s) => s.endpoint);
  if (dead.length) {
    await sbAny(supabaseAdmin).from("push_subscriptions").delete().in("endpoint", dead);
  }
  return results.filter((r) => r.ok).length;
}

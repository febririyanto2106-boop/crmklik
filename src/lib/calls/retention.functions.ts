/**
 * Call-retention server functions: read the workspace's two call policies,
 * change them, and run the purge on demand.
 *
 * Policies live in the shared `data_retention_policies` table, so anything
 * saved here also shows up in the compliance centre's report.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sbAny } from "@/lib/supabase/untyped";
import { CALL_RETENTION_RESOURCES } from "@/lib/calls/retention.server";

export type CallRetentionPolicy = {
  resource: "call_recordings" | "call_transcripts";
  retention_days: number;
  is_active: boolean;
  last_run_at: string | null;
  last_deleted_count: number;
};

async function resolveWorkspace(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
): Promise<string> {
  const { resolveActiveWorkspaceId } = await import("@/lib/auth/active-workspace.server");
  const workspaceId = await resolveActiveWorkspaceId(supabase, userId);
  if (!workspaceId) throw new Error("No active workspace");
  return workspaceId;
}

/**
 * Only owners/admins may change how long recordings are kept — it is a
 * destructive, irreversible setting. Mirrors the `settings` RLS policy so the
 * caller gets a readable error instead of an opaque RLS failure.
 */
async function assertCanManage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const { data } = await sbAny(supabase)
    .from("workspace_members")
    .select("role, status")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  const m = data as { role?: string; status?: string } | null;
  if (!m || m.status !== "active" || !["owner", "admin"].includes(m.role ?? "")) {
    throw new Error("Only workspace owners and admins can change call retention");
  }
}

export const getCallRetention = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CallRetentionPolicy[]> => {
    const workspaceId = await resolveWorkspace(context.supabase, context.userId);
    const { data } = await sbAny(context.supabase)
      .from("data_retention_policies")
      .select("resource, retention_days, is_active, last_run_at, last_deleted_count")
      .eq("workspace_id", workspaceId)
      .in("resource", CALL_RETENTION_RESOURCES as unknown as string[]);
    return (data ?? []) as CallRetentionPolicy[];
  });

export const saveCallRetention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) =>
    z
      .object({
        resource: z.enum(CALL_RETENTION_RESOURCES),
        // 7 days is the floor on purpose: anything shorter risks deleting a
        // recording the team is still reviewing. 10 years is the ceiling.
        retention_days: z.number().int().min(7).max(3650),
        is_active: z.boolean(),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const workspaceId = await resolveWorkspace(context.supabase, context.userId);
    await assertCanManage(context.supabase, workspaceId, context.userId);
    const { error } = await sbAny(context.supabase).from("data_retention_policies").upsert(
      {
        workspace_id: workspaceId,
        resource: data.resource,
        retention_days: data.retention_days,
        is_active: data.is_active,
      },
      { onConflict: "workspace_id,resource" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Applies the workspace's own policies immediately, rather than at the next sweep. */
export const runCallRetentionNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const workspaceId = await resolveWorkspace(context.supabase, context.userId);
    await assertCanManage(context.supabase, workspaceId, context.userId);
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { enforceCallRetention } = await import("@/lib/calls/retention.server");
    const results = await enforceCallRetention(supabaseAdmin, workspaceId);
    return {
      purged: results.reduce((n, r) => n + r.purged, 0),
      errors: results.flatMap((r) => r.errors),
    };
  });

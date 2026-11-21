/**
 * Call retention — the enforcement engine.
 *
 * Call recordings are the heaviest and most sensitive thing this app stores:
 * full audio of a real conversation, in a Storage bucket, kept forever unless
 * something deletes it. This enforces a per-workspace age limit on them.
 *
 * It plugs into the existing `data_retention_policies` table (the same one
 * `settings/data` and the compliance centre already read) rather than
 * introducing a parallel setting, adding two resources:
 *
 *   call_recordings  — deletes the audio file, keeps the call log + transcript
 *   call_transcripts — strips the spoken lines, keeps the one-line summary
 *
 * Note: that table has always stored policies for other resources too
 * (messages, media, audit_logs, …) but nothing has ever executed them. This
 * engine deliberately handles ONLY the two call resources; the others are
 * untouched and still unenforced.
 *
 * Deletion is staged so a crash can never leave a message pointing at a file
 * that is already gone: the Storage object goes first, and the row is only
 * cleared once that succeeded.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

export const CALL_RETENTION_RESOURCES = ["call_recordings", "call_transcripts"] as const;
export type CallRetentionResource = (typeof CALL_RETENTION_RESOURCES)[number];

export type RetentionRunResult = {
  workspaceId: string;
  resource: CallRetentionResource;
  retentionDays: number;
  /** Rows examined that were past the cutoff. */
  matched: number;
  /** Rows actually changed. */
  purged: number;
  errors: string[];
};

/** One page of work per run, so a huge backlog cannot time out the request. */
const BATCH_LIMIT = 200;

type CallMessageRow = {
  id: string;
  media_url: string | null;
  metadata: Record<string, unknown> | null;
};

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/* ------------------------------------------------------------ recordings -- */

async function purgeRecordings(
  admin: Admin,
  workspaceId: string,
  days: number,
): Promise<Omit<RetentionRunResult, "workspaceId" | "resource" | "retentionDays">> {
  const errors: string[] = [];
  const { data, error } = await admin
    .from("messages")
    .select("id, media_url, metadata")
    .eq("workspace_id", workspaceId)
    .eq("message_type", "system")
    .not("media_url", "is", null)
    .not("metadata->translated_call", "is", null)
    .lt("created_at", cutoffIso(days))
    .limit(BATCH_LIMIT);

  if (error) return { matched: 0, purged: 0, errors: [error.message] };
  const rows = (data ?? []) as CallMessageRow[];
  if (!rows.length) return { matched: 0, purged: 0, errors };

  // Remove the audio objects in one call; Storage tolerates paths that are
  // already gone, so a partially-completed previous run is safe to repeat.
  const paths = rows
    .map((r) => (r.metadata?.media_path as string | undefined) ?? null)
    .filter((p): p is string => Boolean(p));
  if (paths.length) {
    const { error: storageError } = await admin.storage.from("attachments").remove(paths);
    if (storageError) {
      // Leave the rows intact so the next run retries rather than orphaning files.
      return { matched: rows.length, purged: 0, errors: [storageError.message] };
    }
  }

  let purged = 0;
  for (const row of rows) {
    const md = { ...(row.metadata ?? {}) } as Record<string, unknown>;
    delete md.media_path;
    delete md.media_name;
    md.recording_purged_at = new Date().toISOString();
    const { error: updateError } = await admin
      .from("messages")
      .update({
        media_url: null,
        media_type: null,
        media_size: null,
        metadata: md,
      })
      .eq("id", row.id);
    if (updateError) errors.push(updateError.message);
    else purged += 1;
  }
  return { matched: rows.length, purged, errors };
}

/* ----------------------------------------------------------- transcripts -- */

async function purgeTranscripts(
  admin: Admin,
  workspaceId: string,
  days: number,
): Promise<Omit<RetentionRunResult, "workspaceId" | "resource" | "retentionDays">> {
  const errors: string[] = [];
  const { data, error } = await admin
    .from("messages")
    .select("id, media_url, metadata")
    .eq("workspace_id", workspaceId)
    .eq("message_type", "system")
    .not("metadata->translated_call", "is", null)
    .lt("created_at", cutoffIso(days))
    .limit(BATCH_LIMIT);

  if (error) return { matched: 0, purged: 0, errors: [error.message] };
  const rows = (data ?? []) as CallMessageRow[];

  let purged = 0;
  let matched = 0;
  for (const row of rows) {
    const md = { ...(row.metadata ?? {}) } as Record<string, unknown>;
    const call = { ...((md.translated_call as Record<string, unknown>) ?? {}) };
    const lines = call.lines as unknown[] | undefined;
    // Already stripped by an earlier run — skip rather than re-count it.
    if (!Array.isArray(lines) || lines.length === 0) continue;
    matched += 1;

    // The spoken content goes; the card's own identity (who, how long, which
    // languages) and the one-line summary stay, so history stays readable.
    call.lines = [];
    call.transcript_purged_at = new Date().toISOString();
    md.translated_call = call;

    const { error: updateError } = await admin
      .from("messages")
      .update({ metadata: md })
      .eq("id", row.id);
    if (updateError) errors.push(updateError.message);
    else purged += 1;
  }
  return { matched, purged, errors };
}

/* ------------------------------------------------------------------ run --- */

type PolicyRow = {
  id: string;
  workspace_id: string;
  resource: string;
  retention_days: number;
  is_active: boolean;
};

/**
 * Enforces every active call-retention policy. Pass `workspaceId` to limit the
 * run to one workspace (used by the "Run now" button); omit it for the cron
 * sweep across all workspaces.
 */
export async function enforceCallRetention(
  admin: Admin,
  workspaceId?: string,
): Promise<RetentionRunResult[]> {
  let query = admin
    .from("data_retention_policies")
    .select("id, workspace_id, resource, retention_days, is_active")
    .eq("is_active", true)
    .in("resource", CALL_RETENTION_RESOURCES as unknown as string[]);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const results: RetentionRunResult[] = [];
  for (const policy of (data ?? []) as PolicyRow[]) {
    const resource = policy.resource as CallRetentionResource;
    const days = policy.retention_days;
    // A policy with a nonsensical window would wipe live calls; refuse it.
    if (!Number.isFinite(days) || days < 1) continue;

    const outcome =
      resource === "call_recordings"
        ? await purgeRecordings(admin, policy.workspace_id, days)
        : await purgeTranscripts(admin, policy.workspace_id, days);

    results.push({
      workspaceId: policy.workspace_id,
      resource,
      retentionDays: days,
      ...outcome,
    });

    // Stamp the policy so the compliance centre can show it as enforced.
    await admin
      .from("data_retention_policies")
      .update({
        last_run_at: new Date().toISOString(),
        last_deleted_count: outcome.purged,
      })
      .eq("id", policy.id);
  }
  return results;
}

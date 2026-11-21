/**
 * Translated-call analytics.
 *
 * There is no `calls` table: a finished call is a `system` message carrying
 * `metadata.translated_call`, and an unanswered one is a `system` message
 * carrying `metadata.missed_call`. That is the whole source of truth, so this
 * reads both shapes out of `messages` and aggregates them in one pass.
 *
 * Everything is derived from data already stored — nothing extra is written
 * per call to feed this page.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sbAny } from "@/lib/supabase/untyped";

export type CallAnalytics = {
  range: { from: string; to: string; days: number };
  totals: {
    answered: number;
    missed: number;
    /** answered / (answered + missed), as a percentage. */
    answerRate: number;
    talkTimeSec: number;
    avgDurationSec: number;
    longestSec: number;
    recorded: number;
    /** recorded / answered, as a percentage. */
    recordedRate: number;
    videoCalls: number;
  };
  daily: Array<{ date: string; answered: number; missed: number; talkMinutes: number }>;
  languagePairs: Array<{ pair: string; calls: number; talkMinutes: number }>;
  agents: Array<{
    userId: string;
    name: string;
    calls: number;
    talkMinutes: number;
    avgDurationSec: number;
  }>;
  contacts: Array<{ name: string; calls: number; talkMinutes: number }>;
};

type MessageRow = {
  id: string;
  created_at: string;
  media_url: string | null;
  sent_by: string | null;
  metadata: Record<string, unknown> | null;
};

type CallMeta = {
  contact_name?: string;
  call_type?: string;
  duration_sec?: number;
  agent_locale?: string;
  guest_locale?: string;
};

/** "bn-IN" -> "bn". Keeps pair labels short without another lookup table. */
function shortLocale(locale: string | undefined): string {
  if (!locale) return "?";
  return locale.split("-")[0] || "?";
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export const getCallAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) =>
    z.object({ days: z.number().int().min(1).max(365).default(30) }).parse(v ?? {}),
  )
  .handler(async ({ data, context }): Promise<CallAnalytics> => {
    const { resolveActiveWorkspaceId } = await import("@/lib/auth/active-workspace.server");
    const workspaceId = await resolveActiveWorkspaceId(context.supabase, context.userId);

    const to = new Date();
    const from = new Date(to.getTime() - data.days * 24 * 60 * 60 * 1000);
    const empty: CallAnalytics = {
      range: { from: from.toISOString(), to: to.toISOString(), days: data.days },
      totals: {
        answered: 0,
        missed: 0,
        answerRate: 0,
        talkTimeSec: 0,
        avgDurationSec: 0,
        longestSec: 0,
        recorded: 0,
        recordedRate: 0,
        videoCalls: 0,
      },
      daily: [],
      languagePairs: [],
      agents: [],
      contacts: [],
    };
    if (!workspaceId) return empty;

    // Answered and missed calls sit under different metadata keys. They are
    // fetched as two queries rather than one `or` across a JSON path: the
    // single-key `.not(...)` form is the one already used elsewhere in this
    // codebase, and running both in parallel costs the same wall time.
    const base = () =>
      sbAny(context.supabase)
        .from("messages")
        .select("id, created_at, media_url, sent_by, metadata")
        .eq("workspace_id", workspaceId)
        .eq("message_type", "system")
        .gte("created_at", from.toISOString())
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(5000);

    const [answeredRes, missedRes] = await Promise.all([
      base().not("metadata->translated_call", "is", null),
      base().not("metadata->missed_call", "is", null),
    ]);
    if (answeredRes.error) throw new Error(answeredRes.error.message);
    if (missedRes.error) throw new Error(missedRes.error.message);

    const messages = [
      ...((answeredRes.data ?? []) as MessageRow[]),
      ...((missedRes.data ?? []) as MessageRow[]),
    ];
    if (!messages.length) return empty;

    const daily = new Map<string, { answered: number; missed: number; talkSec: number }>();
    const pairs = new Map<string, { calls: number; talkSec: number }>();
    const agents = new Map<string, { calls: number; talkSec: number }>();
    const contacts = new Map<string, { calls: number; talkSec: number }>();

    let answered = 0;
    let missed = 0;
    let talkTimeSec = 0;
    let longestSec = 0;
    let recorded = 0;
    let videoCalls = 0;

    const bumpDay = (iso: string, field: "answered" | "missed", seconds: number) => {
      const key = dayKey(iso);
      const d = daily.get(key) ?? { answered: 0, missed: 0, talkSec: 0 };
      d[field] += 1;
      d.talkSec += seconds;
      daily.set(key, d);
    };

    for (const row of messages) {
      const md = row.metadata ?? {};
      const call = md.translated_call as CallMeta | undefined;

      if (!call) {
        if (md.missed_call) {
          missed += 1;
          bumpDay(row.created_at, "missed", 0);
        }
        continue;
      }

      // A missing, negative or absurd duration would skew every average.
      const seconds = Math.max(0, Math.min(6 * 60 * 60, Math.round(call.duration_sec ?? 0)));
      answered += 1;
      talkTimeSec += seconds;
      if (seconds > longestSec) longestSec = seconds;
      // A purged recording clears media_url, so this counts what is still held.
      if (row.media_url) recorded += 1;
      if (call.call_type === "video") videoCalls += 1;
      bumpDay(row.created_at, "answered", seconds);

      const pair = `${shortLocale(call.agent_locale)} - ${shortLocale(call.guest_locale)}`;
      const p = pairs.get(pair) ?? { calls: 0, talkSec: 0 };
      p.calls += 1;
      p.talkSec += seconds;
      pairs.set(pair, p);

      if (row.sent_by) {
        const a = agents.get(row.sent_by) ?? { calls: 0, talkSec: 0 };
        a.calls += 1;
        a.talkSec += seconds;
        agents.set(row.sent_by, a);
      }

      const contactName = call.contact_name?.trim() || "Unknown";
      const c = contacts.get(contactName) ?? { calls: 0, talkSec: 0 };
      c.calls += 1;
      c.talkSec += seconds;
      contacts.set(contactName, c);
    }

    // Resolve agent ids to names in one query rather than per row.
    const agentNames = new Map<string, string>();
    if (agents.size) {
      const { data: profiles } = await sbAny(context.supabase)
        .from("profiles")
        .select("id, full_name, email")
        .in("id", [...agents.keys()]);
      for (const p of (profiles ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string | null;
      }>) {
        agentNames.set(p.id, p.full_name || p.email || "Unknown agent");
      }
    }

    // Fill every day in the window, quiet ones included, so the chart shows
    // real gaps instead of silently compressing the x-axis.
    const series: CallAnalytics["daily"] = [];
    for (let i = data.days - 1; i >= 0; i -= 1) {
      const key = dayKey(new Date(to.getTime() - i * 24 * 60 * 60 * 1000).toISOString());
      const d = daily.get(key);
      series.push({
        date: key,
        answered: d?.answered ?? 0,
        missed: d?.missed ?? 0,
        talkMinutes: Math.round(((d?.talkSec ?? 0) / 60) * 10) / 10,
      });
    }

    const totalAttempts = answered + missed;
    const mins = (sec: number) => Math.round((sec / 60) * 10) / 10;

    return {
      range: { from: from.toISOString(), to: to.toISOString(), days: data.days },
      totals: {
        answered,
        missed,
        answerRate: totalAttempts ? Math.round((answered / totalAttempts) * 100) : 0,
        talkTimeSec,
        avgDurationSec: answered ? Math.round(talkTimeSec / answered) : 0,
        longestSec,
        recorded,
        recordedRate: answered ? Math.round((recorded / answered) * 100) : 0,
        videoCalls,
      },
      daily: series,
      languagePairs: [...pairs.entries()]
        .map(([pair, v]) => ({ pair, calls: v.calls, talkMinutes: mins(v.talkSec) }))
        .sort((a, b) => b.calls - a.calls),
      agents: [...agents.entries()]
        .map(([userId, v]) => ({
          userId,
          name: agentNames.get(userId) ?? "Unknown agent",
          calls: v.calls,
          talkMinutes: mins(v.talkSec),
          avgDurationSec: Math.round(v.talkSec / v.calls),
        }))
        .sort((a, b) => b.calls - a.calls),
      contacts: [...contacts.entries()]
        .map(([name, v]) => ({ name, calls: v.calls, talkMinutes: mins(v.talkSec) }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 10),
    };
  });

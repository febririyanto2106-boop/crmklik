/**
 * Call-retention sweep — deletes recordings/transcripts past their workspace's
 * retention window.
 *
 * POST /api/public/calls/retention-sweep
 * Auth: `x-cron-token` (INTERNAL_CRON_TOKEN), same guard as the booking tick.
 * Intended to run daily; each run processes one batch per policy, so a large
 * backlog simply drains over several runs rather than timing out.
 */
import { createFileRoute } from "@tanstack/react-router";
import { guardCronRequest } from "@/lib/api/request-guards";

export const Route = createFileRoute("/api/public/calls/retention-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = guardCronRequest(request);
        if (denied) return denied;
        try {
          const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
          const { enforceCallRetention } = await import("@/lib/calls/retention.server");
          const results = await enforceCallRetention(supabaseAdmin);
          return Response.json({
            ok: true,
            policies: results.length,
            purged: results.reduce((n, r) => n + r.purged, 0),
            errors: results.flatMap((r) => r.errors),
            results,
          });
        } catch (e) {
          return Response.json(
            { error: "sweep_failed", detail: e instanceof Error ? e.message : "unknown" },
            { status: 500 },
          );
        }
      },
    },
  },
});

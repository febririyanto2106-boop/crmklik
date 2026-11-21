/**
 * Pure demo-mode resolution logic — no framework imports. Split out of
 * `mode.server.ts` so it can be imported from files that TanStack Start's
 * import-protection plugin denies from pulling in `@tanstack/react-start/server`
 * (any `*.server.*` file, e.g. mode.server.ts, is denied in the client bundle —
 * safe here only because this module never imports that package at all).
 */
function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function serverAppMode(): "demo" | "production" {
  const m = (process.env.APP_MODE ?? process.env.VITE_APP_MODE ?? "").toLowerCase();
  if (m === "demo") return "demo";
  if (m === "production") return "production";
  if (truthy(process.env.DEMO_MODE) || truthy(process.env.VITE_DEMO_MODE)) return "demo";
  return "production";
}

export const isServerDemoMode = () => serverAppMode() === "demo";
export const isServerProductionMode = () => serverAppMode() === "production";

/**
 * Structured error thrown when the server refuses a write in demo mode.
 * Callers should surface `error.message` unchanged — it is user-safe.
 */
export class DemoModeBlockedError extends Error {
  readonly code = "DEMO_MODE_BLOCKED";
  readonly status = 423; // "Locked" — semantically closer than 403
  constructor(action = "This action") {
    super(`Demo Mode is enabled. ${action} is disabled in the live demonstration.`);
    this.name = "DemoModeBlockedError";
  }
}

export type DemoBlockedLogEntry = {
  action: string;
  endpoint?: string;
  method?: string;
  userId?: string | null;
  ip?: string | null;
  ua?: string | null;
  at: string;
};

export function logServerBlocked(entry: DemoBlockedLogEntry) {
  // Structured log line — pick this up in your log aggregator by "demo.blocked".
  console.warn("[demo.blocked]", JSON.stringify(entry));
}

/**
 * Server-side mode resolution + reusable middleware for TanStack server
 * functions and server routes. Import this from ".functions.ts" handlers
 * (never from client bundles) — the mode-check itself lives in `./mode-core`
 * (no framework imports) so files that ARE client-reachable can use it
 * without tripping TanStack Start's `*.server.*` import-protection rule.
 * `demoWriteGuard`, which gets referenced in `.middleware([...])` arrays on
 * client-reachable `.functions.ts` files, lives in `./demo-write-guard` for
 * the same reason.
 */
import { getRequest, getRequestIP } from "@tanstack/react-start/server";

export {
  serverAppMode,
  isServerDemoMode,
  isServerProductionMode,
  DemoModeBlockedError,
} from "./mode-core";
import { isServerDemoMode, DemoModeBlockedError, logServerBlocked } from "./mode-core";

/** Same guard as `demoWriteGuard` (./demo-write-guard), for use inside server
 * route handlers directly (no middleware chain). Currently unused, kept for
 * server-only route handlers that never go through a `.middleware([...])` array. */
export function assertNotDemo(actionLabel = "This action"): void {
  if (!isServerDemoMode()) return;
  const req = safeGetRequest();
  logServerBlocked({
    action: actionLabel,
    endpoint: req?.url,
    method: req?.method,
    ip: safeGetIp(),
    ua: req?.headers.get("user-agent") ?? null,
    at: new Date().toISOString(),
  });
  throw new DemoModeBlockedError(actionLabel);
}

function safeGetRequest() {
  try {
    return getRequest();
  } catch {
    return null;
  }
}
function safeGetIp() {
  try {
    return getRequestIP({ xForwardedFor: true }) ?? null;
  } catch {
    return null;
  }
}

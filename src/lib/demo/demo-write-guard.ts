/**
 * `demoWriteGuard` lives here — NOT in `mode.server.ts` — on purpose: it gets
 * referenced inside `.middleware([...])` arrays of `.functions.ts` files that
 * client route components import directly (e.g. `themes.functions.ts`). Any
 * file matching `*.server.*` is denied from importing
 * `@tanstack/react-start/server` in the client bundle (TanStack Start's
 * import-protection default), so this file — same pattern as
 * `auth-middleware.ts`'s `requireSupabaseAuth` — deliberately does NOT use
 * that suffix even though it imports from `@tanstack/react-start/server`.
 */
import { createMiddleware } from "@tanstack/react-start";
import { getRequest, getRequestIP } from "@tanstack/react-start/server";
import { isServerDemoMode, DemoModeBlockedError, logServerBlocked } from "./mode-core";

/**
 * Attach to any write-oriented `createServerFn` to reject calls when
 * APP_MODE === "demo". No-op in production.
 *
 *   export const deleteThing = createServerFn({ method: "POST" })
 *     .middleware([requireSupabaseAuth, demoWriteGuard("Delete thing")])
 *     .handler(async () => { ... });
 */
export function demoWriteGuard(actionLabel = "This action") {
  return createMiddleware({ type: "function" }).server(async ({ next, context }) => {
    if (!isServerDemoMode()) return next();
    const req = safeGetRequest();
    logServerBlocked({
      action: actionLabel,
      endpoint: req?.url,
      method: req?.method,
      userId: (context as { userId?: string } | undefined)?.userId ?? null,
      ip: safeGetIp(),
      ua: req?.headers.get("user-agent") ?? null,
      at: new Date().toISOString(),
    });
    throw new DemoModeBlockedError(actionLabel);
  });
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

/**
 * Push-only service worker.
 *
 * Deliberately served from /push-sw.js rather than /sw.js: the worker at /sw.js
 * is a one-release cleanup worker that unregisters itself (and any app-shell
 * worker at that URL) on activation. Keeping push on a separate script URL
 * means this worker survives that cleanup. It caches nothing and intercepts no
 * fetches — it exists only to show notifications while the app's tab is
 * backgrounded or closed.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const isCall = data.kind === "incoming_call";
  const title = data.title || "WACRM";
  const options = {
    body: data.body || "",
    // Reusing one tag per kind means a second ring replaces the first banner
    // instead of stacking a column of identical alerts.
    tag: isCall ? "incoming-call" : data.kind || "wacrm",
    renotify: isCall,
    requireInteraction: isCall,
    icon: data.icon || "/icon-192.png",
    badge: "/icon-192.png",
    // Phones vibrate for a call the way they would for a phone call.
    vibrate: isCall ? [200, 100, 200, 100, 200] : undefined,
    data: { url: data.url || "/inbox", kind: data.kind || "" },
    actions: isCall ? [{ action: "answer", title: "Answer" }] : undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/inbox";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Prefer an already-open app tab: focusing it keeps the signed-in session
      // and the live Realtime subscriptions rather than booting a cold one.
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(target);
            } catch {
              /* a focused tab is already good enough */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

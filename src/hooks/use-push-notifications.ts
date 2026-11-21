/**
 * Browser push subscription management for the signed-in agent.
 *
 * The in-tab ring (`use-incoming-call-alert`) only works while the inbox tab is
 * open and foregrounded. This hook registers a push-only service worker so the
 * same alert reaches the agent when the tab is backgrounded, minimised or
 * closed entirely.
 *
 * Everything here degrades silently: on a browser without push, or an install
 * with no VAPID keys configured, `supported` is false and the UI simply hides
 * the option rather than showing a broken toggle.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getPushPublicKey,
  registerPushDevice,
  sendTestPush,
  unregisterPushDevice,
} from "@/lib/push/push.functions";

const SW_URL = "/push-sw.js";

/** VAPID keys travel as base64url; `applicationServerKey` needs raw bytes. */
function b64urlToUint8Array(input: string): Uint8Array {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function browserSupportsPush(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export type PushState = {
  /** The browser can do push AND the server has VAPID keys configured. */
  supported: boolean;
  /** This device currently has an active subscription stored on the server. */
  enabled: boolean;
  busy: boolean;
  permission: NotificationPermission | "unsupported";
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  test: () => Promise<void>;
};

export function usePushNotifications(): PushState {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    browserSupportsPush() ? Notification.permission : "unsupported",
  );

  // Ask the server once whether push is configured at all, and reconcile the
  // local subscription state with what the browser actually holds.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!browserSupportsPush()) {
        setChecked(true);
        return;
      }
      try {
        const { publicKey: key } = await getPushPublicKey();
        if (cancelled) return;
        setPublicKey(key);
        if (key) {
          const reg = await navigator.serviceWorker.getRegistration(SW_URL);
          const sub = await reg?.pushManager.getSubscription();
          if (!cancelled) setEnabled(Boolean(sub));
        }
      } catch {
        /* push stays off */
      } finally {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    if (!browserSupportsPush() || !publicKey) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        toast.error("Notifications blocked", {
          description:
            "Allow notifications for this site in your browser settings to get call alerts.",
        });
        return;
      }

      const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
      await navigator.serviceWorker.ready;

      // Reuse an existing subscription when there is one; re-subscribing with a
      // different key throws rather than replacing it.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64urlToUint8Array(publicKey) as BufferSource,
        });
      }

      const json = sub.toJSON() as { endpoint?: string; keys?: Record<string, string> };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("The browser returned an incomplete subscription");
      }
      await registerPushDevice({
        data: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          user_agent: navigator.userAgent.slice(0, 500),
        },
      });

      setEnabled(true);
      toast.success("Call alerts enabled on this device", {
        description: "You'll be notified even when this tab is closed.",
      });
    } catch (e) {
      toast.error("Could not enable notifications", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }, [publicKey]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_URL);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        // Tell the server first: if unsubscribing succeeds but the delete call
        // fails, the row would linger and push would silently 410 forever.
        await unregisterPushDevice({ data: { endpoint: sub.endpoint } }).catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
      }
      setEnabled(false);
      toast.success("Call alerts turned off on this device");
    } finally {
      setBusy(false);
    }
  }, []);

  const test = useCallback(async () => {
    setBusy(true);
    try {
      const { sent } = await sendTestPush();
      if (sent > 0) {
        toast.success(`Test notification sent to ${sent} device${sent === 1 ? "" : "s"}`);
      } else {
        toast.error("No device received the test", {
          description: "Enable alerts on this device first.",
        });
      }
    } catch (e) {
      toast.error("Test failed", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    supported: checked && browserSupportsPush() && Boolean(publicKey),
    enabled,
    busy,
    permission,
    enable,
    disable,
    test,
  };
}

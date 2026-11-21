/**
 * Short-lived TURN credentials for translated calls, via Cloudflare Calls.
 *
 * STUN alone cannot connect peers behind strict/symmetric NATs (common on
 * corporate and mobile networks) — a TURN relay is the difference between
 * "connects everywhere" and "stuck on connecting". Cloudflare's TURN service
 * mints per-call credentials from a server-held key; the browser only ever
 * sees a credential that expires within hours.
 *
 * Deliberately NOT auth-guarded: the guest side of a call is a public,
 * account-free page and needs relay credentials too. The credentials are
 * short-lived and only good for relaying media, so exposing the mint
 * endpoint is comparable to exposing the call page itself.
 *
 * Needs `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` (a TURN
 * key, created under Cloudflare Calls → TURN). Without them, calls fall
 * back to STUN-only exactly as before.
 */
import { createServerFn } from "@tanstack/react-start";

/** Public STUN — always included so ICE can still try a direct path. */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/** Comfortably outlasts any realistic call, short enough to not be worth stealing. */
const TURN_TTL_SECONDS = 4 * 60 * 60;

export const getCallIceServers = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ iceServers: RTCIceServer[] }> => {
    const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
    const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
    if (!keyId || !apiToken) return { iceServers: STUN_SERVERS };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
          signal: controller.signal,
        },
      );
      if (!res.ok) throw new Error(`Cloudflare TURN said ${res.status}`);
      const data = (await res.json()) as {
        iceServers?: { urls?: string | string[]; username?: string; credential?: string };
      };
      const turn = data.iceServers;
      if (!turn?.urls || !turn.username || !turn.credential) {
        throw new Error("Cloudflare TURN returned no credentials");
      }
      return {
        iceServers: [
          ...STUN_SERVERS,
          { urls: turn.urls, username: turn.username, credential: turn.credential },
        ],
      };
    } catch (e) {
      // A TURN outage must never block calls that direct STUN can carry.
      console.warn("[calls] TURN credentials unavailable, falling back to STUN:", e);
      return { iceServers: STUN_SERVERS };
    } finally {
      clearTimeout(timer);
    }
  },
);

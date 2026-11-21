/**
 * Web Push (RFC 8030 / 8291 / 8292) on top of Web Crypto only.
 *
 * The `web-push` npm package depends on Node's `crypto` module, which is not
 * available on this app's production target (Cloudflare Workers). Everything
 * here uses `globalThis.crypto.subtle`, so the exact same code runs in the Node
 * dev server and in a Worker.
 *
 * Two pieces are needed per delivery:
 *  1. VAPID (RFC 8292) — an ES256 JWT proving we own the application server
 *     key, sent in the `Authorization` header.
 *  2. aes128gcm payload encryption (RFC 8291) — the push service must never be
 *     able to read the notification body, so it is encrypted against the
 *     subscription's own `p256dh`/`auth` keys.
 */

export type PushSubscriptionKeys = { p256dh: string; auth: string };

export type PushTarget = {
  endpoint: string;
  keys: PushSubscriptionKeys;
};

export type PushSendResult = {
  ok: boolean;
  status: number;
  /** True when the push service says this subscription is dead and should be deleted. */
  gone: boolean;
  error?: string;
};

/* ------------------------------------------------------------------ base64 */

function b64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/* -------------------------------------------------------------------- VAPID */

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

/**
 * Reads the VAPID keypair from the environment. Returns null (rather than
 * throwing) when it is unset, so push simply stays off on installs that have
 * not configured it — every caller treats push as best-effort.
 */
export function readVapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:admin@localhost";
  return { publicKey, privateKey, subject };
}

/**
 * Builds the ES256 JWT for one push origin. `aud` must be the *origin* of the
 * endpoint (not the full URL) or push services reject the request with 401.
 */
async function signVapidJwt(audience: string, vapid: VapidConfig): Promise<string> {
  // The standard VAPID key format is: public = raw uncompressed P-256 point
  // (65 bytes, 0x04 || X || Y), private = the 32-byte scalar `d`. Web Crypto
  // needs all three as a JWK, so X and Y are sliced back out of the public key.
  const pub = b64urlToBytes(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 point (65 bytes)");
  }
  const d = b64urlToBytes(vapid.privateKey);
  if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY must be a base64url 32-byte scalar");

  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      d: bytesToB64url(d),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(
    utf8(
      JSON.stringify({
        aud: audience,
        // 12h; the spec caps this at 24h.
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  // Web Crypto already returns the raw r||s form that JWS ES256 requires.
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

/* ------------------------------------------------------- aes128gcm payload */

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits as ArrayBuffer);
}

/** RFC 8291 §3: encrypt `payload` for one subscription, returning the body bytes. */
async function encryptPayload(
  payload: string,
  keys: PushSubscriptionKeys,
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlToBytes(keys.p256dh);
  const authSecret = b64urlToBytes(keys.auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral application-server keypair, fresh per message.
  const asKeyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", asKeyPair.publicKey)) as ArrayBuffer,
  );

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    (await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      asKeyPair.privateKey,
      256,
    )) as ArrayBuffer,
  );

  // IKM is derived from the shared secret, salted by the subscription's auth
  // secret, and bound to both public keys so a message cannot be replayed at a
  // different subscription.
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const cek = await hkdf(
    salt,
    ikm,
    concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // 0x02 is the padding delimiter marking this as the final (only) record.
  const plaintext = concat(utf8(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    (await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      plaintext,
    )) as ArrayBuffer,
  );

  // Header: salt(16) | record size(4, BE) | key id length(1) | key id(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/* --------------------------------------------------------------------- send */

/**
 * Delivers one notification. Never throws: push is always best-effort, and a
 * single dead subscription must not fail the action that triggered it. Callers
 * should delete the subscription when `gone` is true.
 */
export async function sendWebPush(
  target: PushTarget,
  payload: Record<string, unknown>,
  options: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high" } = {},
): Promise<PushSendResult> {
  const vapid = readVapidConfig();
  if (!vapid) return { ok: false, status: 0, gone: false, error: "VAPID keys not configured" };

  try {
    const audience = new URL(target.endpoint).origin;
    const [jwt, body] = await Promise.all([
      signVapidJwt(audience, vapid),
      encryptPayload(JSON.stringify(payload), target.keys),
    ]);

    const res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(options.ttl ?? 60),
        Urgency: options.urgency ?? "normal",
      },
      body: body as unknown as BodyInit,
    });

    // 404/410 mean the subscription has been revoked by the browser.
    const gone = res.status === 404 || res.status === 410;
    if (res.ok) return { ok: true, status: res.status, gone: false };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, gone, error: text.slice(0, 300) };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      gone: false,
      error: e instanceof Error ? e.message : "Unknown push error",
    };
  }
}

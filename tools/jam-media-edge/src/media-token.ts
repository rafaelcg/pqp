/**
 * The edge's check of a public jam media URL, a port of
 * `openJamPublicMediaUrl` in `server/src/services/jam-public-media.ts` to Web
 * Crypto. The API mints `/jam-media/<token>?e=<exp>&s=<sig>`; this opens it.
 *
 *   1. `e` is 1 to 12 digits of unix seconds, `token` is base64url, `s` is set;
 *   2. `s` equals base64url(HMAC-SHA256(S, `${token}\n${e}`)), compared in
 *      constant time, where `S` is `JAM_PUBLIC_MEDIA_SECRET` (the API's
 *      derived key, a string used as its UTF-8 bytes);
 *   3. `e` is not in the past;
 *   4. `token` is base64url of 12-byte IV, ciphertext, 16-byte GCM tag, and
 *      decrypts under AES-256-GCM with the raw 32 bytes of
 *      HMAC-SHA256(S, "aes-key") to an object key;
 *   5. the key starts with `jam/` and has no `.`/`..`/empty segment, no
 *      backslash and no control character. NOTHING ELSE IN THE BUCKET IS
 *      REACHABLE: the bucket also holds attachments, avatars, stories.
 *
 * WHAT IT PROVES. The API only mints a URL while it is building a public read
 * (a published song, a public part, an approved cover); a private channel
 * jam's media is presigned directly and never gets one. So a valid URL IS the
 * statement "the API considered this object public when it signed this". The
 * Worker has no database and does not re-ask: the bound on a removal is the
 * URL's own expiry (README.md "How long a removal takes").
 *
 * `test/golden.json` is a URL minted by the real server code. The server test
 * and this package's test both pin it, so neither side can drift alone.
 */

const encoder = new TextEncoder();

export type MediaTokenFailure = "malformed" | "expired" | "bad-signature" | "unconfigured";

export type OpenedMediaToken = { key: string; expires: number } | { failure: MediaTokenFailure };

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    return null;
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function hmac(secret: string | Uint8Array, message: string): Promise<Uint8Array> {
  const keyBytes = typeof secret === "string" ? encoder.encode(secret) : secret;
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Constant-time on equal lengths; unequal lengths are not a secret. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** True for a key this Worker may read: under `jam/`, no traversal, nothing odd. */
export function isServableJamKey(key: string): boolean {
  if (!key.startsWith("jam/") || key.length > 512) {
    return false;
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused.
  if (/[\\\u0000-\u001f\u007f]/.test(key)) {
    return false;
  }
  const segments = key.split("/");
  return segments.length >= 2 && !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

export async function openJamMediaToken(
  token: string,
  expires: string | null,
  sig: string | null,
  secret: string | undefined,
  nowMs: number = Date.now(),
): Promise<OpenedMediaToken> {
  if (!token || !expires || !sig || !/^\d{1,12}$/.test(expires) || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { failure: "malformed" };
  }
  if (!secret) {
    return { failure: "unconfigured" };
  }
  const want = base64urlEncode(await hmac(secret, `${token}\n${Number(expires)}`));
  if (!timingSafeEqualStrings(want, sig)) {
    return { failure: "bad-signature" };
  }
  if (Number(expires) * 1000 < nowMs) {
    return { failure: "expired" };
  }
  const raw = base64urlDecode(token);
  if (!raw || raw.length < 12 + 16 + 1) {
    return { failure: "malformed" };
  }
  let plain: ArrayBuffer;
  try {
    const aesKey = await crypto.subtle.importKey("raw", await hmac(secret, "aes-key"), { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    // WebCrypto wants ciphertext then tag in one buffer, which is the layout.
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), tagLength: 128 }, aesKey, raw.subarray(12));
  } catch {
    return { failure: "malformed" };
  }
  let key: string;
  try {
    key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain);
  } catch {
    return { failure: "malformed" };
  }
  if (!isServableJamKey(key)) {
    return { failure: "malformed" };
  }
  return { key, expires: Number(expires) };
}

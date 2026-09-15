/**
 * A faithful port of `server/src/voice/hls-viewer-token.ts`'s VERIFICATION
 * half (this Worker never mints a token — only the API does that).
 *
 * WHY A PORT AND NOT A SHARED IMPORT. This Worker is deployed separately from
 * the API (different runtime, different repo boundary — see README.md for
 * why it is not part of the pnpm workspace), so there is no module boundary
 * to share across. What has to stay identical is the ALGORITHM: base64url
 * payload, HMAC-SHA256 signature, the same claim names and the same failure
 * vocabulary. `test/hls-viewer-token.test.mjs` pins real tokens shaped like
 * ones the API mints (`v`, `u`, `c`, `s`, `e`, `i`, `p`) so a drift between
 * the two implementations shows up as a failing test here, not as a stalled
 * watch party.
 *
 * WHY WEB CRYPTO AND NOT node:crypto. The real module uses
 * `createHmac(...).update(...).digest("base64url")`, which is Node-only.
 * Workers have no Node `crypto` module unless `nodejs_compat` is turned on,
 * and this Worker does not need it: `crypto.subtle` (the Web Crypto API) is
 * available in every Worker and in Node 19+, so the SAME module runs
 * unmodified inside the Worker and under `node --test`. That is also why this
 * file is plain JS rather than TypeScript — `node --test` cannot run `.ts`
 * without a build step, and the whole point of testing this file directly
 * (rather than only through Miniflare) is that a plain function call is the
 * cheapest thing that can catch a signing mismatch.
 *
 * WHAT STAYS AUTHORITATIVE ON THE ORIGIN. This module answers "is this
 * signature valid, for this channel and session, and not yet expired" —
 * exactly what the origin's `verifyHlsViewerToken` answers. It does NOT
 * answer "has this user since been banned or lost VIEW" — that is
 * `hls-revocation.ts`'s in-memory set on the API process, and it exists only
 * there. A ban therefore still needs an origin round trip to take effect, on
 * whatever cadence this Worker's cache forwards one (see README.md
 * "What this Worker does NOT make faster"). This Worker only ever removes
 * origin trips for requests that would have gotten the SAME playlist body
 * back anyway; it never gates on anything the origin doesn't also check on
 * the request that actually reaches it.
 */

/** Query parameter name on the proxy URL. Mirrors `HLS_VIEWER_TOKEN_PARAM`. */
export const HLS_VIEWER_TOKEN_PARAM = "t";

/**
 * Mirrors `HLS_VIEWER_TOKEN_TTL_MS` in `hls-viewer-token.ts`. Only used here
 * as the fallback for `issuedAt` on a token minted before that claim existed
 * (see `verifyHlsViewerToken`'s doc comment there) — this Worker does not use
 * `issuedAt` for anything itself, since revocation is origin-only.
 */
export const HLS_VIEWER_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Every reason a token can fail, in the API's own words
 * (`HlsViewerTokenFailure` in `hls-viewer-token.ts`). Logged, never the token
 * itself: this exists to explain a rejection, not to help reproduce one.
 * @typedef {"missing"|"unconfigured"|"malformed"|"bad-signature"|"expired"|"wrong-channel"|"wrong-session"} HlsViewerTokenFailure
 */

/**
 * @param {string} base64Url
 * @returns {Uint8Array}
 */
function base64UrlToBytes(base64Url) {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {string}
 */
function bytesToBase64Url(bytes) {
  const array = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = "";
  for (const byte of array) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time equality over the UTF-8 bytes of two STRINGS. Mirrors
 * `equal()` in `hls-viewer-token.ts`: length is compared up front (so this is
 * not constant-time ACROSS different lengths, same as the origin), and the
 * comparison itself never branches on content.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= x[i] ^ y[i];
  }
  return diff === 0;
}

/** @type {Map<string, Promise<CryptoKey>>} */
const keyCache = new Map();

/**
 * The HMAC-SHA256 key for a given secret string, imported once and reused.
 * `secret` here is `HLS_VIEWER_TOKEN_SECRET` — the OUTPUT of the origin's
 * `viewerSecret()`, not the raw Clerk secret. See README.md "The secret this
 * Worker holds, and the one it does not".
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
function hmacKey(secret) {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(secret, cached);
  }
  return cached;
}

/**
 * The base64url signature over `payload`, the same string `sign()` produces
 * in `hls-viewer-token.ts`.
 * @param {string} payload
 * @param {string} secret
 * @returns {Promise<string>}
 */
async function sign(payload, secret) {
  const key = await hmacKey(secret);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64Url(digest);
}

/**
 * Whether `mac` is the correct signature for `payload`.
 *
 * THIS COMPARES STRINGS, NOT DECODED BYTES — same as `equal()` in
 * `hls-viewer-token.ts`, which runs `Buffer.from(token.slice(dot + 1))`
 * against `Buffer.from(sign(payload, secret))`: both sides stay in their
 * base64url TEXT form and are compared byte-for-byte as UTF-8. A first
 * attempt at this port base64url-DECODED the caller-supplied `mac` before
 * comparing, which is a different check — it turns a garbled, non-base64
 * signature into "malformed" from a failed decode instead of "bad-signature"
 * from a failed comparison, which is what `hls-viewer-token.test.mjs`'s
 * "malformed: no separator, and garbage base64" case caught. The origin never
 * tries to decode a mac it doesn't trust yet.
 * @param {string} payload
 * @param {string} mac
 * @param {string} secret
 * @returns {Promise<boolean>}
 */
async function macValid(payload, mac, secret) {
  const expected = await sign(payload, secret);
  return constantTimeEqual(mac, expected);
}

/**
 * @param {string} payload base64url
 * @returns {Record<string, unknown> | null}
 */
function decodeClaims(payload) {
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(payload));
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Splits a token into its payload and signature, or null if it is not even
 * shaped like one (no `.`, or the `.` at position 0).
 * @param {string} token
 * @returns {{ payload: string; mac: string } | null}
 */
function splitToken(token) {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  return { payload: token.slice(0, dot), mac: token.slice(dot + 1) };
}

/**
 * The user id a token was issued to, and when — or null if the token does
 * not verify for exactly this channel and session. Mirrors
 * `verifyHlsViewerToken` in `hls-viewer-token.ts`.
 *
 * `purpose` is accepted for shape parity with the origin (claim `p`, added
 * for #543) but this Worker's only caller is the LIVE playlist route, which
 * — same as the origin's own live route — omits it and accepts a token of
 * any purpose. A caller that cares would pass it explicitly, same rule as
 * the origin.
 *
 * @param {string | null | undefined} token
 * @param {{ channelId: string; startedAt: number; purpose?: "live" | "replay" }} expected
 * @param {string | null | undefined} secret
 * @param {number} [now]
 * @returns {Promise<{ userId: string; issuedAt: number } | null>}
 */
export async function verifyHlsViewerToken(token, expected, secret, now = Date.now()) {
  if (!token || !secret) {
    return null;
  }
  const split = splitToken(token);
  if (!split) {
    return null;
  }
  if (!(await macValid(split.payload, split.mac, secret))) {
    return null;
  }
  const claims = decodeClaims(split.payload);
  if (
    !claims ||
    claims.v !== 1 ||
    typeof claims.u !== "string" ||
    typeof claims.e !== "number" ||
    claims.e < now ||
    claims.c !== expected.channelId ||
    claims.s !== expected.startedAt ||
    (expected.purpose !== undefined &&
      (claims.p ?? "live") !== expected.purpose)
  ) {
    return null;
  }
  return {
    userId: /** @type {string} */ (claims.u),
    issuedAt:
      typeof claims.i === "number"
        ? claims.i
        : /** @type {number} */ (claims.e) - HLS_VIEWER_TOKEN_TTL_MS,
  };
}

/**
 * Why `verifyHlsViewerToken` returned null, in the API's own vocabulary.
 * Mirrors `describeHlsViewerToken` in `hls-viewer-token.ts`, minus the
 * `purpose` check (the origin's own `describeHlsViewerToken` doesn't check it
 * either — it exists to explain the common, honest failures, and purpose
 * mismatches are rare enough to read as "malformed" here rather than earning
 * their own word twice).
 *
 * @param {string | null | undefined} token
 * @param {{ channelId: string; startedAt: number }} expected
 * @param {string | null | undefined} secret
 * @param {number} [now]
 * @returns {Promise<HlsViewerTokenFailure | null>}
 */
export async function describeHlsViewerToken(token, expected, secret, now = Date.now()) {
  if (!token) {
    return "missing";
  }
  if (!secret) {
    return "unconfigured";
  }
  const split = splitToken(token);
  if (!split) {
    return "malformed";
  }
  if (!(await macValid(split.payload, split.mac, secret))) {
    return "bad-signature";
  }
  const claims = decodeClaims(split.payload);
  if (
    !claims ||
    claims.v !== 1 ||
    typeof claims.u !== "string" ||
    typeof claims.e !== "number"
  ) {
    return "malformed";
  }
  if (claims.c !== expected.channelId) {
    return "wrong-channel";
  }
  if (claims.s !== expected.startedAt) {
    return "wrong-session";
  }
  if (claims.e < now) {
    return "expired";
  }
  return null;
}

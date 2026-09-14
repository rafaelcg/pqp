/**
 * A faithful port of `mintHlsPartyPass`/`verifyHlsPartyPass`/
 * `describeHlsPartyPass`'s VERIFICATION half in
 * `server/src/voice/hls-viewer-token.ts` -- this Worker never mints a party
 * pass, only the API does. Same reasoning as `hls-viewer-token.js`'s own doc
 * comment for why this is a port and not a shared import, and why Web
 * Crypto rather than `node:crypto`; not repeated here.
 *
 * WHY A SEPARATE FILE AND A SEPARATE SECRET, NOT A THIRD `p` VALUE ON THE
 * EXISTING PORT. The origin derives the party pass's signing key from a
 * DIFFERENT `info` string than the viewer token's (`partySecret()` in
 * `hls-viewer-token.ts`), so a party pass and a viewer token can never verify
 * as each other, by construction, on either side of this boundary. Keeping
 * the Worker's two checks in two files with two secrets (`HLS_VIEWER_TOKEN_SECRET`
 * and `HLS_PARTY_PASS_SECRET`, both Worker vars) mirrors that on purpose,
 * so a future edit to one cannot quietly widen what the other accepts.
 *
 * WHAT THIS DOES NOT DO. It answers "is this signature valid, for this
 * channel and session, and not yet expired" -- nothing about revocation. See
 * `index.ts`'s `isPartyPassRevoked` and its TODO for the trade-off this
 * leaves open, and `mintHlsPartyPass`'s doc comment in `hls-viewer-token.ts`
 * for why that gap exists and how wide it is.
 */

/** Query parameter name on the proxy URL. Mirrors `HLS_PARTY_PASS_PARAM`. */
export const HLS_PARTY_PASS_PARAM = "pp";

/**
 * @typedef {"missing"|"unconfigured"|"malformed"|"bad-signature"|"expired"|"wrong-channel"|"wrong-session"} HlsPartyPassFailure
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
 * The user id a party pass was issued to, and when -- or null if it does not
 * verify for exactly this channel and session. Mirrors `verifyHlsPartyPass`
 * in `hls-viewer-token.ts`.
 *
 * @param {string | null | undefined} token
 * @param {{ channelId: string; startedAt: number }} expected
 * @param {string | null | undefined} secret
 * @param {number} [now]
 * @returns {Promise<{ userId: string; issuedAt: number } | null>}
 */
export async function verifyHlsPartyPass(token, expected, secret, now = Date.now()) {
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
    claims.s !== expected.startedAt
  ) {
    return null;
  }
  return {
    userId: /** @type {string} */ (claims.u),
    issuedAt: /** @type {number} */ (claims.i),
  };
}

/**
 * Why `verifyHlsPartyPass` returned null, in the API's own vocabulary.
 * Mirrors `describeHlsPartyPass` in `hls-viewer-token.ts`.
 *
 * @param {string | null | undefined} token
 * @param {{ channelId: string; startedAt: number }} expected
 * @param {string | null | undefined} secret
 * @param {number} [now]
 * @returns {Promise<HlsPartyPassFailure | null>}
 */
export async function describeHlsPartyPass(token, expected, secret, now = Date.now()) {
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

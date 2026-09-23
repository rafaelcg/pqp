/**
 * The edge's check of the SEGMENT capability (`?s=`), a line-for-line port of
 * `describeHlsSegmentToken` in `server/src/voice/hls-segment-token.ts`. Plain
 * JS for the same reason `hls-viewer-token.js` is (README.md "Why a port, and
 * why plain JS"): the test suite imports it straight into Node.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. The API mints this token into every
 * segment line of a rendered playlist when `LIVE_HLS_SEGMENT_BASE_URL` points
 * at this Worker. It names a channel, a session, a rendition and an expiry,
 * and no viewer: the playlist it sits in is shared by every viewer of that
 * rendition, exactly as the presigned R2 URLs it replaces were. So it is the
 * same credential as a presigned URL (whoever holds the playlist may fetch
 * its segments until the URL expires), scoped tighter than one: it cannot
 * name another channel's objects, another session's, or another rung's,
 * because the object key is rebuilt from the path it is checked against.
 * There is no per-user revocation on this route for the same reason there is
 * none on a presigned URL; the bound is the TTL (`LIVE_HLS_URL_TTL_SECONDS`,
 * 900 s by default), and the playlist route, which DOES check the viewer and
 * the revocation denylist, is what stops a revoked viewer learning the next
 * segment's URL.
 *
 * The key is `HLS_SEGMENT_TOKEN_SECRET`: HMAC-SHA256(CLERK_SECRET_KEY,
 * "pqp-hls-segment"), base64url. A different derived key than the viewer
 * token and the party pass, so neither can ever pass as this.
 */

import { decodeClaims, macValid, splitToken } from "./hls-viewer-token.js";

export const HLS_SEGMENT_TOKEN_PARAM = "s";

/**
 * `${startedAt}-${rung}_` (or `${startedAt}_` for a pre-ladder session): the
 * prefix LiveKit egress gives every segment of one rendition.
 * @param {string} startedAt
 * @param {string} rung
 */
export function segmentNamePrefix(startedAt, rung) {
  return rung ? `${startedAt}-${rung}_` : `${startedAt}_`;
}

/**
 * Null when the token authorizes `expected.name`, otherwise the reason word
 * (the same vocabulary as the viewer token, plus `wrong-rendition`).
 *
 * @param {string | null | undefined} token
 * @param {{ channelId: string, startedAt: string, name: string }} expected
 *   `startedAt` as the path carries it (digits); compared numerically.
 * @param {string | undefined} secret
 * @param {number} [now]
 * @returns {Promise<null | "missing" | "unconfigured" | "malformed" | "bad-signature" | "expired" | "wrong-channel" | "wrong-session" | "wrong-rendition">}
 */
export async function describeHlsSegmentToken(token, expected, secret, now = Date.now()) {
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
    claims.k !== "seg" ||
    typeof claims.r !== "string" ||
    typeof claims.e !== "number"
  ) {
    return "malformed";
  }
  if (claims.c !== expected.channelId) {
    return "wrong-channel";
  }
  if (typeof claims.s !== "number" || String(claims.s) !== expected.startedAt) {
    return "wrong-session";
  }
  if (!expected.name.startsWith(segmentNamePrefix(expected.startedAt, claims.r))) {
    return "wrong-rendition";
  }
  if (claims.e < now) {
    return "expired";
  }
  return null;
}

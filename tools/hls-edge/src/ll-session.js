/**
 * The remux session id for one channel's LL session — a faithful port of
 * `deriveLlSessionId` in `server/src/voice/hls-remux.ts` (PR #580,
 * `docs/plans/LL_HLS.md` task L1.5).
 *
 * WHY THIS NEEDS TO EXIST HERE TOO. `docs/plans/LL_HLS.md` task L2.2 has
 * this Worker render the LL media playlist itself, from state it polls
 * straight off the remux origin (`ll-playlist-origin.ts`) — never through
 * the API. That poll needs the remux `sessionId` the origin's `state.json`
 * lives under (`GET /s/:id/state.json`, see `ll-state.js`'s doc comment for
 * the full contract), and this Worker has no database and no API round trip
 * to ask the origin for it. The origin doesn't need to ask either: the id is
 * a PURE function of `(channelId, startedAtMs)` — see `hls-remux.ts`'s own
 * doc comment on `deriveLlSessionId`, "NOTHING IN THIS FILE IS KEPT IN
 * PROCESS MEMORY AS THE ONLY RECORD OF ANYTHING" — so recomputing it here
 * from the exact same two values (both already public inputs on this
 * Worker's own request path: `channelId` and `startedAt` are path segments
 * of every playlist request it answers) reproduces the exact same id the
 * API stored on the `hls_sessions` row and the exact same id `pqp-remux`
 * itself will be started with.
 *
 * WHY A PORT AND NOT A SHARED IMPORT. Same reasoning as `hls-viewer-token.js`
 * (see that file's header): this Worker deploys separately from the API,
 * in a different repo boundary, with no module boundary to share across.
 * Unlike that port, this one needs no secret — a session id is not a
 * capability, and the origin computes the exact same id from the exact same
 * two values, so there is nothing here for an attacker to forge that would
 * grant them anything a guessed or leaked `sessionId` doesn't already.
 *
 * WEB CRYPTO, NOT node:crypto, for the same reason as `hls-viewer-token.js`:
 * `crypto.subtle.digest` runs unmodified inside the Worker and under
 * `node --test` (Node 19+), so this file stays plain JS, testable without a
 * build step or Miniflare, and `test/ll-session.test.mjs` can pair it
 * against `node:crypto`'s `createHash` — the same two-backends-one-answer
 * fidelity check `hls-viewer-token.test.mjs` already uses for the token
 * port.
 */

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Byte-for-byte the same construction as `deriveLlSessionId` in
 * `server/src/voice/hls-remux.ts`: sha256 over `${channelId}:${startedAtMs}`,
 * then reshaped into UUID-like groups purely so the result matches the
 * `z.string().uuid()` shape `remuxSessionInfoSchema.sessionId` expects on
 * the API side — collision resistance comes from sha256 over the pair, not
 * from the UUID version/variant nibbles, which exist only for that shape
 * match.
 *
 * @param {string} channelId
 * @param {number} startedAtMs
 * @returns {Promise<string>}
 */
export async function deriveLlSessionId(channelId, startedAtMs) {
  const input = new TextEncoder().encode(`${channelId}:${startedAtMs}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hash = toHex(digest);
  const variantNibble = "89ab"[Number.parseInt(hash[16], 16) % 4];
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variantNibble}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

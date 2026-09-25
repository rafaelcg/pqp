/**
 * pqp-hls-edge: the Worker in front of watch-party playlist polling.
 *
 * THE PROBLEM (docs/plans/RELOAD_STORM.md has the numbers). hls.js and the
 * native players re-fetch a rendition's media playlist every 2 to 4 seconds
 * for as long as someone watches. At 500 viewers that is 125 to 250 identical
 * requests a second against the API's playlist proxy
 * (`server/src/api/index.ts`, `hls-live-window.ts`, `hls-viewer-token.ts`) —
 * identical because the playlist BODY is a pure function of (channel,
 * session, rung, current 2 s render) and does not depend on which viewer
 * asked, only the per-viewer `?t=` token differs. Segment bytes already go
 * straight to R2; this Worker exists to stop 500 browsers from each
 * re-deriving the same playlist on the API process that also owns the
 * database connection pool.
 *
 * THE SHAPE. This Worker's route (`playlist-route.ts`) is the SAME path
 * shape as the origin's (`/api/voice/hls-playlist/:channelId/:startedAt(/:rung)?`)
 * — deliberately, because `LIVE_HLS_PLAYLIST_BASE_URL` on the server
 * (`hls-egress.ts`) just prepends this Worker's origin to that same path, so
 * a viewer's client makes the exact request it always made, against a
 * different host. See `docs/WATCH_PARTY.md` "Playlists at the edge".
 *
 * THREE JOBS, THREE MODULES, kept apart on purpose (see
 * `playlist-origin.ts`'s doc comment for why — the owner wants a watch party
 * to keep playing when the API is down, which means the THIRD job below
 * needs a second implementation later, and this file should not have to
 * change when it arrives):
 *
 *  1. Is this even a playlist request, and for what — `playlist-route.ts`.
 *  2. Is the caller allowed to see it — `hls-viewer-token.js`.
 *  3. Where do the actual bytes come from — `playlist-origin.ts`. Today:
 *     ask the API, same as always. This file's OWN job is what sits around
 *     that: deciding whether a given request is even askABLE for (never the
 *     session/master route — see below), sharing one answer across every
 *     viewer who asks in the same window, and never caching a failure.
 *
 * TWO PLAYLIST ROUTES, TWO CACHING RULES, because the two playlist bodies
 * are not the same kind of thing (and, since task L2.3, a THIRD route that
 * is not a playlist at all — see below):
 *
 *  - `/:channelId/:startedAt/:rung` — a RENDITION's media playlist. Its body
 *    depends on nothing but (channel, session, rung, time), never on who
 *    asked. This is what gets polled every 2-4 s, and it is the only route
 *    this Worker caches: one origin fetch per rung per `CACHE_TTL_SECONDS`,
 *    shared by every viewer whose request lands on the same Cloudflare colo
 *    within that window (see README.md "Load shape" for what that collapses
 *    to and does not).
 *  - `/:channelId/:startedAt` (no rung) — the SESSION url. Once a session has
 *    run a ladder this is a MASTER playlist whose variant lines embed the
 *    REQUESTING viewer's own `?t=` token (`buildMasterPlaylistFor` in
 *    `hls-playlist-proxy.ts`); a pre-ladder session instead gets a plain
 *    media playlist straight off `buildSignedPlaylist`, same as a rendition.
 *    This Worker cannot tell those two cases apart without the database
 *    lookup only the origin makes, and caching the FIRST case across viewers
 *    would hand one viewer's capability token to everyone who hit the shared
 *    cache entry within the window — coupling their playback to that first
 *    viewer's revocation status. So this route is always forwarded with the
 *    caller's own token, never cached. It is also fetched once per viewer
 *    join, not polled, so the cost this Worker exists to cut was never here.
 *    **`?mode=ll` on this route is what selects the low-latency master**
 *    (`requestsLlMode`, `playlist-route.ts`): the API stamps it onto an LL
 *    session's URL, and without it this Worker does not so much as look at
 *    the remux origin. It used to decide by probing, which meant a session
 *    whose first `state.json` was still a moment away read as "conventional"
 *    — the whole of 2026-09-15, written out at that branch.
 *  - `/:channelId/:startedAt/:rung/:name` — an LL session's MEDIA BYTES
 *    (`ll-media.ts`, task L2.3): the part, segment and init files an LL
 *    playlist's own URIs point at, fetched from the remux box and cached
 *    per colo as `immutable` for a year. A conventional rung's segments
 *    never come through here — those are presigned R2 URLs the player
 *    fetches straight from storage — so this route exists only because the
 *    remux box is a private origin with nothing to presign. Dispatched in
 *    `fetch` below, before `handlePlaylistRequest`, because it shares only
 *    ONE thing with the playlist routes: the credential check, which is why
 *    that is what moved into `viewer-access.ts`.
 *
 * WHAT STAYS AUTHORITATIVE, AND THE ONE THING THAT DOES NOT. The token check
 * (signature, expiry, channel, session) runs in THIS Worker, on every
 * request, using the same HMAC scheme as `hls-viewer-token.ts`
 * (`./hls-viewer-token.js`) — an invalid or expired token never reaches the
 * cache or the origin.
 *
 * REVOCATION: SIGNED OFF 2026-09-14, BOUND TO 30 SECONDS WHEN KV IS
 * PROVISIONED. `hls-revocation.ts`'s in-memory set exists only on the API
 * process; this Worker cannot consult IT directly, but `server/src/voice/hls-edge-revocation.ts`
 * writes the same eviction to a Cloudflare KV denylist (`HLS_REVOKED_USERS`)
 * this Worker DOES consult -- `PartyPassRevocationGate` in
 * `party-pass-revocation.js`, checked before EVERY cache lookup on the
 * rendition route, for both a `?t=` token and a `?pp=` party pass alike (see
 * `handlePlaylistRequest`). With the KV namespace provisioned, a revoked
 * viewer's next request is refused within the gate's 30 s cache window
 * regardless of how long other viewers keep a rung's shared cache entry
 * warm. Without it, the original trade-off applies unchanged for a `?t=`
 * token (bounded by that token's own TTL, already accepted when
 * `LIVE_HLS_PLAYLIST_BASE_URL` first shipped in #559) -- and a party pass is
 * refused outright once `ENVIRONMENT=production`
 * (`partyPassRequiresKvInProduction`) rather than riding its full 6 h
 * ceiling with nothing checking it. See README.md "Enabling in production"
 * for the provisioning steps and `docs/plans/RELOAD_STORM.md` for the
 * numbers this Worker exists to cut in the first place.
 */

import { PartyPassRevocationGate } from "./party-pass-revocation.js";
import { authorizeViewer, logRejection, statusForRejection } from "./viewer-access.js";
import { cacheKeyRequest, safeCacheMatch, safeCachePut } from "./edge-cache.js";
import { handleLlMediaRequest } from "./ll-media.js";
import { parsePlaylistPath, parseSegmentPath, requestsLlMode } from "./playlist-route.js";
import { handleSegmentRequest, warmNewSegments, type SegmentEnv } from "./segment-media.js";
import { ApiPlaylistOrigin, type PlaylistOrigin } from "./playlist-origin.js";
import { LlPlaylistOrigin } from "./ll-playlist-origin.js";
import { applyLlRenditionCredential } from "./ll-playlist.js";
import { playlistOriginKindForRung } from "./ll-state.js";
import { handleCorsPreflight, withCors } from "./cors.js";
import { logEvent } from "./log.js";
import { handleBlockingReload, parseBlockingReloadParams } from "./hls-blocking-reload.js";
import { coalesceFetch } from "./coalesced-fetch.js";

export interface Env extends SegmentEnv {
  /** The API origin this Worker fetches playlists from, e.g. https://api.pqp.gg (a var). */
  ORIGIN_BASE?: string;
  /**
   * The signing secret for viewer tokens. NOT the raw `CLERK_SECRET_KEY` —
   * see README.md "The secret this Worker holds, and the one it does not".
   * Unset: every token fails verification and this Worker serves nothing but
   * 401s, the same fail-closed shape `viewerSecret()` has on the origin.
   */
  HLS_VIEWER_TOKEN_SECRET?: string;
  /**
   * The signing secret for party passes -- a DIFFERENT derived key than
   * `HLS_VIEWER_TOKEN_SECRET`, matching `partySecret()` in
   * `hls-viewer-token.ts` (see that function's doc comment for why a
   * different key, not a claim). Unset: `?pp=` is never checked and this
   * Worker falls all the way back to gating on `?t=` alone, exactly as it
   * did before the party pass existed.
   */
  HLS_PARTY_PASS_SECRET?: string;
  /**
   * The revocation denylist, written by `server/src/voice/hls-edge-revocation.ts`
   * the moment a viewer is kicked, banned, or loses VIEW (`hls-revocation.ts`'s
   * own eviction seam) -- see `party-pass-revocation.js`'s `PartyPassRevocationGate`
   * for how this Worker reads it, and README.md "Enabling in production" for
   * how an operator provisions it. Unbound: `HLS_REVOKED_USERS` governs
   * nothing outside production (fails open, the pre-sign-off shape) and
   * `partyPassRequiresKvInProduction` refuses party passes outright once
   * `ENVIRONMENT=production`.
   */
  HLS_REVOKED_USERS?: KVNamespace;
  /**
   * `"production"` on the one real deploy (`wrangler.jsonc`'s default var).
   * Governs exactly one thing: whether a party pass may be honored with no
   * KV binding behind it -- see `partyPassRequiresKvInProduction`. Anything
   * else (unset for `wrangler dev`, `"development"`, `"staging"`) keeps the
   * pre-sign-off fail-open default, which is what local development and a
   * self-host with no KV namespace still need to work at all.
   */
  ENVIRONMENT?: string;
  /** Comma-separated allowlist. Unset: every origin is echoed back (see cors.ts). */
  CORS_ALLOWED_ORIGINS?: string;
  /**
   * The remux box's own Caddy origin, e.g. `https://egress-1.pqp.gg:8443`
   * (`docs/plans/LL_HLS.md` §1, `LIVE_HLS_REMUX_ORIGIN_URL` on the API side
   * — this is this Worker's OWN copy of that value, not shared with it: the
   * two processes never call into each other). Unset: `LlPlaylistOrigin` is
   * never `ready`, every request behaves exactly as it did before task
   * `L2.2` — no LL rung is ever offered, and `/ll`/`/ll-audio` 404 like any
   * other unrecognized rung. Deliberately NEVER forwarded to a viewer — see
   * `ll-playlist-origin.ts`'s header.
   */
  LL_ORIGIN_BASE?: string;
  /**
   * `pqp-remuxd`'s `MEDIA_ORIGIN_KEY` (`internal/control/server.go`, PR
   * #584's Farol-review fix), set here with `wrangler secret put` —
   * NEVER in `vars`, matching `HLS_VIEWER_TOKEN_SECRET` above — since
   * unlike `LL_ORIGIN_BASE` this value is a credential, not just a host.
   * Sent as `X-Pqp-Origin-Key` on every request `LlPlaylistOrigin` makes
   * against `LL_ORIGIN_BASE` (parts, init segments, `state.json`) — see
   * `ll-playlist-origin.ts`'s `originKey` doc comment. Unset: no header is
   * sent, matching `pqp-remuxd` leaving `MEDIA_ORIGIN_KEY` empty for a
   * loopback-only `CONTROL_LISTEN`. Deliberately never forwarded to a
   * viewer, the same rule `LL_ORIGIN_BASE` documents above.
   */
  LL_ORIGIN_KEY?: string;
  /**
   * How many part targets of `PART-HOLD-BACK` an LL rendition playlist
   * advertises — `ll-playlist.js`'s `DEFAULT_PART_HOLD_BACK_PARTS` (6) when
   * unset, which at the remux's 500 ms part target is a 3.0 s hold-back.
   *
   * A STRING, LIKE EVERY `vars` ENTRY, and deliberately forgiving: anything
   * that is not a finite number is ignored and the default stands, because a
   * typo in a tuning knob must never be able to render an invalid playlist to
   * a live audience. The floor and the ceiling are enforced where the value
   * is used (`partHoldBackSeconds`): never below RFC 8216bis 4.4.3.8's
   * `3 x PART-TARGET`, never above `TARGETDURATION`.
   *
   * It exists because the right number is a property of where the viewers
   * are, not of this repo: the default was three parts (1.5 s) until viewers
   * in the UK watching a box in São Paulo — ~200 ms of round trip, ~400 ms
   * blocking reloads — spent the first seconds of every stream fighting the
   * live edge.
   */
  LL_PART_HOLD_BACK_PARTS?: string;
  /**
   * `"on"` warms a rendition's newest segments into the colo cache before the
   * playlist that reveals them is handed on (`warmNewSegments` in
   * `segment-media.ts`). Anything else, including unset: off.
   */
  SEGMENT_PREWARM?: string;
  // ALWAYS-ON (not yet built, see playlist-origin.ts and
  // docs/plans/ALWAYS_ON.md task A1.x): a future R2-backed PlaylistOrigin
  // would add its own bindings here (an R2Bucket, a DurableObjectNamespace).
  // Nothing reads them yet — see the commented placeholders in
  // wrangler.jsonc for why they are not declared until something does.
}

/**
 * One gate per isolate, same lifetime as the Worker instance -- see
 * `party-pass-revocation.js` for what it checks, the fail-open/fail-closed
 * rules, and the 30 s cache bound. Used for BOTH credential kinds on the
 * rendition route now, not only a party pass -- see `handlePlaylistRequest`
 * for where each call site sits relative to the cache lookup, and
 * README.md "Enabling in production" for why that is what answers Farol's
 * "shared rendition cache bypasses viewer revocation" finding.
 */
const partyPassRevocationGate = new PartyPassRevocationGate();

/**
 * How long a rendition's playlist is shared across viewers. The egress
 * re-renders a live playlist roughly once a second per rendition
 * (`hls-playlist-proxy.ts`); 2 s keeps this Worker's copy no more stale than
 * a viewer's own poll interval already tolerates, while still collapsing
 * every request inside that window into one origin fetch.
 */
const CACHE_TTL_SECONDS = 2;

const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * Cache hits are the common case at party scale and logging every one would
 * be exactly the write-amplifier pitfall 16 warns about, so they are counted
 * and flushed as one summary line periodically instead of one line each.
 * Origin fetches (misses) are already rate-limited to roughly one per rung
 * per `CACHE_TTL_SECONDS` by the cache itself, so those are logged directly.
 */
const HIT_FLUSH_INTERVAL_MS = 10_000;
let hitsSinceFlush = 0;
let hitFlushWindowStart = Date.now();

function noteCacheHit(channelId: string, rung: string): void {
  hitsSinceFlush += 1;
  const now = Date.now();
  if (now - hitFlushWindowStart >= HIT_FLUSH_INTERVAL_MS) {
    logEvent("hlsEdge.cacheHits", {
      count: hitsSinceFlush,
      windowMs: now - hitFlushWindowStart,
      // Last channel/rung only — this is a load counter, not a per-key
      // breakdown, and a per-key map would be the same amplifier problem one
      // level down.
      sampleChannelId: channelId,
      sampleRung: rung,
    });
    hitsSinceFlush = 0;
    hitFlushWindowStart = now;
  }
}

/**
 * How long a viewer whose LL master is not ready yet is told to wait. One
 * second: `pqp-remux` writes a part roughly every 500 ms once it has
 * subscribed, so a session that is warming is usually ready within one or
 * two of these, and a player that comes back sooner would only re-ask an
 * origin the `notReadyCache` is already shielding.
 */
const LL_NOT_READY_RETRY_AFTER_SECONDS = 1;

/**
 * `503`, with a `Retry-After` and a reason, for an LL master this Worker
 * cannot build YET.
 *
 * WHY A RETRYABLE REFUSAL AND NOT THE CONVENTIONAL LADDER. There is no
 * conventional ladder for an LL session: the API stops one driver when it
 * starts the other (`reconcileLiveHlsNow`), so "fall back" would hand the
 * audience a master for renditions nothing is writing — which is exactly
 * what happened on 2026-09-15 and looked, from every log this Worker keeps,
 * like a healthy request. A 503 is a fact the player can act on: hls.js
 * retries a manifest on any status outside 4xx (`retryForHttpStatus`), the
 * web client widens `manifestLoadPolicy` for LL so the warm-up window is
 * ridden out and paces its retries to THIS `Retry-After` rather than as fast
 * as hls.js will go (`LL_HLS_MANIFEST_RETRY_DELAY_MS`), and
 * `useLiveHlsReady` keeps polling once a second until the master parses as
 * live.
 *
 * `no-store` because the answer is true for about a second by construction,
 * and caching it anywhere between here and the viewer would outlive the
 * condition it describes.
 */
function llNotReady(reason: string): Response {
  return new Response(`LL playlist not ready (${reason})`, {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": String(LL_NOT_READY_RETRY_AFTER_SECONDS),
      "Cache-Control": "no-store",
      "X-HLS-Edge-Mode": "ll",
      "X-HLS-Edge-LL-Not-Ready": reason,
    },
  });
}

/**
 * `hlsEdge.llMasterNotReady`, at most once per (channel, reason) per
 * `LL_NOT_READY_LOG_WINDOW_MS`, carrying how many it stood in for.
 *
 * Every viewer of a warming party re-asks for the master once a second
 * (`useLiveHlsReady`), so logging each refusal would be pitfall 16's
 * write-amplifier: five hundred people joining one party would write five
 * hundred lines a second about one fact. Bounded the same way
 * `logRejection`'s table is (`viewer-access.ts`) — `channelId` is an
 * attacker-controlled path segment, so the map needs a ceiling, not just a
 * window.
 */
const LL_NOT_READY_LOG_WINDOW_MS = 10_000;
const LL_NOT_READY_LOG_MAX_ENTRIES = 500;
const llNotReadyLog = new Map<string, { at: number; suppressed: number }>();

function noteLlMasterNotReady(channelId: string, reason: string): void {
  const key = `${channelId}:${reason}`;
  const now = Date.now();
  const seen = llNotReadyLog.get(key);
  if (seen && now - seen.at < LL_NOT_READY_LOG_WINDOW_MS) {
    seen.suppressed += 1;
    return;
  }
  logEvent("hlsEdge.llMasterNotReady", {
    channelId,
    reason,
    suppressed: seen?.suppressed ?? 0,
  });
  if (!seen && llNotReadyLog.size >= LL_NOT_READY_LOG_MAX_ENTRIES) {
    for (const [existingKey, entry] of llNotReadyLog) {
      if (now - entry.at >= LL_NOT_READY_LOG_WINDOW_MS) {
        llNotReadyLog.delete(existingKey);
      }
    }
    if (llNotReadyLog.size >= LL_NOT_READY_LOG_MAX_ENTRIES) {
      const oldestKey = llNotReadyLog.keys().next().value;
      if (oldestKey !== undefined) {
        llNotReadyLog.delete(oldestKey);
      }
    }
  }
  llNotReadyLog.set(key, { at: now, suppressed: 0 });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Exported for `test/index.test.mjs` ONLY, the same convention
 * `ll-playlist-origin.ts` documents on its own class: this function reaches
 * `caches.default`/`ctx.waitUntil` only past the rendition route's cache
 * lookup, so a request for the SESSION/MASTER route (`rung` unset,
 * including the LL master added by task L2.2) never touches a Workers-only
 * global and can run directly under `node --test` against the compiled
 * output in `dist/` -- see that test file's header for why it is scoped to
 * exactly that route.
 */
export async function handlePlaylistRequest(
  request: Request,
  origins: { api: PlaylistOrigin; ll: LlPlaylistOrigin },
  ctx: ExecutionContext,
  env: Pick<Env, "HLS_VIEWER_TOKEN_SECRET" | "HLS_PARTY_PASS_SECRET" | "HLS_REVOKED_USERS" | "ENVIRONMENT">,
  channelId: string,
  startedAt: string,
  rung: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  // One credential check for every route this Worker answers --
  // `viewer-access.ts`, which is where this block used to live inline (see
  // that module's header for why it moved). `allowPartyPass` is scoped to
  // the RENDITION route: the session/master route below is always forwarded
  // fresh with the caller's own token and never cached, so there is nothing
  // for the pass's longer life to buy there. `checkTokenRevocation` stays
  // false because this route's token-path revocation check runs LATER, after
  // the blocking-reload directive is validated -- see "THE FIX FOR..."
  // below.
  const access = await authorizeViewer({
    url,
    env,
    gate: partyPassRevocationGate,
    channelId,
    startedAt,
    rung,
    allowPartyPass: Boolean(rung),
    checkTokenRevocation: false,
  });
  if (!access.ok) {
    return json(access.status, { error: "Unauthorized", reason: access.reason });
  }
  const { verified, usedPartyPass, token, credential } = access;

  if (!origins.api.ready) {
    logEvent("hlsEdge.originNotConfigured", { channelId, rung: rung ?? null });
    return text(503, "Origin not configured");
  }

  // LL-HLS blocking playlist reload (RFC 8216bis 6.2.5.2, `_HLS_msn` /
  // `_HLS_part` — docs/plans/LL_HLS.md task L2.1, hls-blocking-reload.js). A
  // request that carries neither parameter gets `{ kind: "none" }` and falls
  // straight through to the existing cache-or-forward logic below,
  // unchanged. Validated here, before the rung branch, because a malformed
  // directive is a malformed request on EITHER route.
  const blockingReload = parseBlockingReloadParams(url);
  if (blockingReload.kind === "invalid") {
    logEvent("hlsEdge.blockingReloadRejected", {
      channelId,
      rung: rung ?? null,
      reason: blockingReload.reason,
    });
    return json(400, { error: "Bad Request", reason: blockingReload.reason });
  }

  // The session/master URL: see the module doc comment for why this route is
  // always forwarded with the caller's OWN token and never cached. Gated on
  // `verified` above, which for this branch can only ever have come from
  // `t` (party pass is skipped when `rung` is unset), so `token` here is
  // never null.
  if (!rung) {
    // WHICH MASTER THIS SESSION GETS IS A PROPERTY OF THE REQUEST, NOT OF A
    // RACE. `requestsLlMode` reads the `?mode=ll` the API stamps onto an LL
    // session's `hlsUrl` (`llPlaylistUrl` in `server/src/voice/hls-remux.ts`,
    // `LIVE_HLS_MODE_PARAM` in `packages/shared/src/live-hls.ts`).
    //
    // What this replaced, and why. This branch used to run the LL path for
    // EVERY master request once `LL_ORIGIN_BASE` was set, ask the remux
    // origin whether a `state.json` existed, and read "no state" as "this
    // party is conventional, forward to the API". Those are different
    // things. Low-latency was enabled in production four times on
    // 2026-09-15 and no viewer was ever handed the low-latency stream: in
    // the last attempt the audience's only master request arrived 300 ms
    // into an LL session, `state.json` was not written yet, and this Worker
    // answered with the conventional ladder's master — for a session whose
    // conventional ladder the API had deliberately not started. The player
    // fetched `/720p30`, got nothing, and the audience read "A transmissão
    // caiu". Nothing logged a failure, because from here it was not one.
    //
    // So: no marker, no LL. A conventional master request never touches the
    // LL origin at all and is the byte-for-byte API forward it was before
    // any of this existed. With the marker, the LL path is the ONLY path —
    // a not-ready origin answers `503 Retry-After`, never the other ladder.
    if (requestsLlMode(url)) {
      // REVOCATION, FOR THIS PATH ONLY. The conventional forward below
      // always reaches the API live, which runs its own always-current
      // `isHlsAccessRevoked` check on every request -- that is why the
      // session/master route otherwise has no revocation check of its own
      // (see the module doc comment, "WHAT THIS WORKER DOES NOT MAKE
      // FASTER"). The LL master never touches the API at all: it is served
      // straight off the remux origin, which has no concept of a viewer's
      // ban/kick/VIEW status. So this Worker has to run the SAME gate the
      // rendition route uses (`PartyPassRevocationGate`) here, before
      // trusting the LL origin -- a revoked viewer must not get a working
      // LL master (and, through it, LL rendition URLs) just because the LL
      // path skips the API. `403`, not the conventional forward: this branch
      // does not fall through any more (see above), and a revoked viewer
      // quietly served SOMETHING would be its own kind of leak.
      const { revoked, kvError } = await partyPassRevocationGate.check(
        env.HLS_REVOKED_USERS,
        verified.userId,
        channelId,
        verified.issuedAt,
      );
      if (kvError) {
        logEvent("hlsEdge.partyPassRevocationCheckError", { channelId });
      }
      if (revoked) {
        logRejection(channelId, rung, "revoked");
        return json(statusForRejection("revoked"), { error: "Unauthorized", reason: "revoked" });
      }
      // MISCONFIGURED, NOT CONVENTIONAL. The API only ever stamps `mode=ll`
      // when it has a remux control plane AND an edge playlist front
      // configured (`resolveHlsMode`), so reaching this with an unready LL
      // origin means this Worker was deployed without `LL_ORIGIN_BASE` while
      // the API was already selecting LL. Answering from the API instead
      // would 404 (it has never known how to render a `mode = 'll'` row) and
      // would do it silently; a loud, retryable 503 is what gets the secret
      // set. Checked HERE rather than in the `requestsLlMode` condition so
      // the two cases keep separate log lines.
      if (!origins.ll.ready) {
        noteLlMasterNotReady(channelId, "origin-not-configured");
        return llNotReady("origin-not-configured");
      }
      const llResult = await origins.ll.fetchMultivariantPlaylist(channelId, startedAt, token!);
      if (llResult.kind === "ready") {
        const headers = new Headers(llResult.response.headers);
        headers.set("X-HLS-Edge-Cache", "BYPASS");
        headers.set("X-HLS-Edge-Mode", "ll");
        return new Response(llResult.response.body, {
          status: llResult.response.status,
          headers,
        });
      }
      noteLlMasterNotReady(channelId, llResult.reason);
      return llNotReady(llResult.reason);
    }
    let originResponse: Response;
    try {
      originResponse = await origins.api.fetchPlaylist({
        channelId,
        startedAt,
        token: token!,
      });
    } catch {
      logEvent("hlsEdge.originError", { channelId, rung: null });
      return text(502, "Origin fetch failed");
    }
    const headers = new Headers(originResponse.headers);
    headers.set("X-HLS-Edge-Cache", "BYPASS");
    return new Response(originResponse.body, {
      status: originResponse.status,
      headers,
    });
  }

  // THE FIX FOR "SHARED RENDITION CACHE BYPASSES VIEWER REVOCATION" (Farol
  // HIGH). A party-pass-authorized request already ran this exact check
  // above, before `verified` was ever set -- this covers the OTHER case, a
  // still-fresh `?t=` token, which previously went straight to the cache
  // lookup below with no revocation check at all once the signature itself
  // verified. Running it HERE, before the blocking-reload hold AND before
  // `cache.match`, closes the gap for both credential kinds the same way: a
  // cache HIT (or a long poll) can no longer outlive a revocation by more
  // than `PARTY_PASS_REVOCATION_CACHE_TTL_MS` (30 s) once `HLS_REVOKED_USERS`
  // is bound. Cheap when it is not: `check()` returns immediately on an
  // unbound KV, same as before this existed. Ordered ahead of the blocking
  // reload below on purpose -- a revoked viewer must not get a long hold
  // open on the origin before being rejected. This also covers an LL
  // rendition (`ll`/`ll-audio`): the check runs before the origin below is
  // ever selected, so it gates the LL origin's rendition path exactly the
  // same way it gates the API's.
  if (!usedPartyPass) {
    const { revoked, kvError } = await partyPassRevocationGate.check(
      env.HLS_REVOKED_USERS,
      verified.userId,
      channelId,
      verified.issuedAt,
    );
    if (kvError) {
      logEvent("hlsEdge.partyPassRevocationCheckError", { channelId });
    }
    if (revoked) {
      logRejection(channelId, rung, "revoked");
      return json(statusForRejection("revoked"), { error: "Unauthorized", reason: "revoked" });
    }
  }

  // Which origin actually answers a RENDITION request: the LL origin for
  // the two LL rung names when it is configured (`LL_ORIGIN_BASE`), the API
  // for every other rung -- unchanged (`playlistOriginKindForRung`,
  // `ll-state.js` -- pure, unit-tested directly for the "every non-LL rung
  // stays on the API" guarantee). A viewer only ever asks for `ll` /
  // `ll-audio` because the LL master above handed them that rung name, so
  // `origins.ll.ready` is expected to already be true here; falling back to
  // `origins.api` when it somehow isn't reproduces today's plain "unknown
  // rung" 404 rather than inventing a new failure shape.
  const origin: PlaylistOrigin =
    playlistOriginKindForRung(rung) === "ll" && origins.ll.ready ? origins.ll : origins.api;
  // Gates `stampLlToken` below: an LL rendition body is rendered with
  // `LL_TOKEN_PLACEHOLDER` (`ll-playlist.js`), never a real token, so it is
  // safe to cache/coalesce across viewers -- but that means it must be
  // turned back into a playable, per-viewer response before this Worker
  // returns it. Reference equality against `origins.ll`, not the rung name,
  // so the check tracks exactly which origin actually answered.
  const isLlRendition = origin === origins.ll;

  // A rendition request carrying a directive skips the 2 s cache entirely —
  // see hls-blocking-reload.js's module doc comment for why a hold is not a
  // cache entry — and shares its origin fetches with the coalesced fetcher
  // below via the injected closure, rather than a second in-flight map.
  // `request.signal` lets the hold notice a disconnected viewer instead of
  // polling on their behalf until the timeout (see that module's doc
  // comment, "DISCONNECTED VIEWERS DO NOT KEEP A LOOP ALIVE").
  if (blockingReload.kind === "directives") {
    const blockingResponse = await handleBlockingReload(
      cacheKeyRequest(request).url,
      blockingReload.value,
      // `handleBlockingReload` wants the bare `FetchedPlaylist` its own
      // poll loop reads `status`/`headers`/`body` off of -- it never writes
      // to `caches.default` itself (see that module's header), so
      // `isProducer` has nothing for it to do. Unwrap `.result` here rather
      // than changing `fetchRenditionCoalesced`'s return shape, which the
      // non-blocking cache-or-forward path below still needs whole.
      () =>
        fetchRenditionCoalesced(cacheKeyRequest(request).url, origin, ctx, {
          channelId,
          startedAt,
          rung,
          token: token!,
          beforeReveal: segmentWarmer(request, env, ctx, channelId, rung),
        }).then((coalesced) => coalesced.result),
      logEvent,
      { channelId, rung },
      request.signal,
      // `ctx.waitUntil`, so the poll loop this request may START outlives
      // this request's own response. Without it the loop's timers and its
      // origin fetch die with this request's context the moment the hold is
      // answered, leaving `state.polling` stuck true and every later request
      // for the rendition parked on a loop that no longer exists -- the
      // thirteen "your Worker's code had hung" 500s of 2026-09-15. See
      // `hls-blocking-reload.js`, the block comment above
      // `LOOP_RESUME_SLACK_MS`.
      { keepAlive: (promise) => ctx.waitUntil(promise) },
    );
    // `null` is the fallback signal (`hls-blocking-reload.js`): this
    // isolate declined to hold THIS request open, for one of three reasons
    // (`MAX_POLL_STATE_ENTRIES` -- the retained-rendition map is full of
    // OTHER active renditions; `MAX_WAITERS_PER_RENDITION` -- this
    // rendition already has as many holds open as it gets; or
    // `MAX_ACTIVE_POLL_LOOPS` -- this isolate is already running as many
    // independent poll loops as it starts at once), so this one request is
    // served the ordinary way below -- the non-blocking cache-or-forward
    // path -- rather than evicting or starving something already active.
    if (blockingResponse) {
      return isLlRendition ? await stampLlToken(blockingResponse, credential) : blockingResponse;
    }
  }

  const cache = caches.default;
  const cacheKey = cacheKeyRequest(request);
  const cached = await safeCacheMatch(cache, cacheKey);
  if (cached) {
    noteCacheHit(channelId, rung);
    const headers = new Headers(cached.headers);
    // THE BROWSER GETS THE SAME LIFETIME ON A HIT AS ON A MISS. What
    // `caches.default` hands back is not what was put: the stored copy comes
    // back carrying the zone's Browser Cache TTL (`max-age=14400`, four
    // hours) and a `Last-Modified`, so a viewer's browser kept a LIVE
    // playlist for hours and hls.js looped the same few seconds of the film
    // from its own HTTP cache (production rehearsal G, 2026-09-25). A live
    // playlist is two seconds of truth, never more.
    headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}`);
    headers.delete("Last-Modified");
    headers.delete("Expires");
    headers.delete("ETag");
    headers.set("X-HLS-Edge-Cache", "HIT");
    const response = new Response(cached.body, { status: cached.status, headers });
    return isLlRendition ? await stampLlToken(response, credential) : response;
  }

  // A CACHE MISS NEEDS AN ORIGIN-VERIFIABLE TOKEN, AND A PARTY PASS IS NOT
  // ONE (`hls-viewer-token.ts`'s `verifyHlsViewerToken` cannot verify a
  // party pass, by construction). A viewer authorised here ONLY by a party
  // pass -- no `t` at all, OR ONE THAT HAS SINCE EXPIRED OR OTHERWISE FAILED
  // VERIFICATION -- cannot make this Worker mint a fresh origin fetch on
  // their own. Gated on `usedPartyPass`, NOT on `!token`: a present-but-bad
  // token is not usable here either, and forwarding it to the coalesced
  // fetch below would have the origin reject it (401) FOR EVERY OTHER
  // CALLER coalesced onto the same shared promise, including ones sitting
  // on their own still-fresh `?t=` -- one viewer's stale token would poison
  // the shared fetch for everyone polling the same rung in the same window.
  // `token` reaching `fetchRenditionCoalesced` below is therefore always the
  // SAME string `verifyHlsViewerToken` just accepted a few lines up, never
  // an unverified one. In practice this is a narrow window: the shared
  // cache above is refilled by ANY other valid viewer of the same rung, and
  // a live party rarely has every viewer's short-lived token expire at
  // once. When it does, the honest answer is a retryable miss, not a 401 --
  // the caller is not unauthorized, there is just no fresh copy this
  // request can produce. `voice.hlsPlaylistRejected` logs "expired" from
  // real 401s; this gets its own counter so the two are never confused when
  // reading a dashboard.
  if (usedPartyPass || !token) {
    logEvent("hlsEdge.partyPassMissWithoutToken", { channelId, rung });
    return text(503, "Playlist not cached; retry shortly");
  }

  let fetched: FetchedPlaylist;
  let isProducer: boolean;
  try {
    const coalesced = await fetchRenditionCoalesced(cacheKey.url, origin, ctx, {
      channelId,
      startedAt,
      rung,
      token,
      beforeReveal: segmentWarmer(request, env, ctx, channelId, rung),
    });
    fetched = coalesced.result;
    isProducer = coalesced.isProducer;
  } catch {
    // Already logged once, inside the shared fetch, regardless of how many
    // callers are awaiting it -- see `fetchRenditionCoalesced`'s doc comment.
    return text(502, "Origin fetch failed");
  }

  if (fetched.status < 200 || fetched.status >= 300) {
    // `usedPartyPass` is always false here -- a party-pass-only rider never
    // reaches `fetchRenditionCoalesced` at all any more (see the guard
    // above), so the token this Worker just forwarded is always the one it
    // verified itself moments ago, and the origin refusing it would be a
    // drift between the two implementations' HMAC checks, not an expiry
    // race. Never cache non-200 — a stream that has not started yet or has
    // just ended must not get frozen into "not found" for every viewer for
    // the rest of the cache window. `hlsEdge.originRejected` is already
    // logged once, inside the shared fetch.
    const headers = new Headers(fetched.headers);
    headers.set("X-HLS-Edge-Cache", "SKIP");
    return new Response(fetched.body, { status: fetched.status, headers });
  }

  const headers = new Headers(fetched.headers);
  // The origin sets `private, no-store` (it has to: the same URL is also
  // Bearer-reachable, per-viewer). This Worker's cache is the one place that
  // is deliberately NOT per-viewer — the body is identical for every valid
  // viewer of this rung in this window — so it overrides that directive on
  // purpose rather than failing to cache at all.
  headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}`);

  // ONLY THE PRODUCER WRITES THE CACHE. Every OTHER caller sharing this
  // coalesced fetch already got the same bytes and is about to build its own
  // response from them below; having each of them ALSO run `cache.put` on
  // the identical key and body was a duplicate write per waiter -- hundreds
  // of them at a synchronized expiry -- for no benefit over the first one
  // (Farol flagged this as a MEDIUM performance issue).
  if (isProducer) {
    const toCache = new Response(fetched.body, { status: 200, headers });
    ctx.waitUntil(safeCachePut(cache, cacheKey, toCache.clone()));
  }

  const response = new Response(fetched.body, { status: 200, headers: new Headers(headers) });
  response.headers.set("X-HLS-Edge-Cache", "MISS");
  // `toCache` above (what gets written into the shared cache) is built from
  // the SAME `fetched.body` the LL origin rendered with `LL_TOKEN_PLACEHOLDER`
  // -- stamping only happens here, on the copy actually leaving the Worker
  // for THIS request, never on what other viewers will later read back out
  // of the cache.
  return isLlRendition ? await stampLlToken(response, credential) : response;
}

/**
 * The shared/coalesced LL rendition body is deliberately token-FREE
 * (`ll-playlist.js`'s `LL_TOKEN_PLACEHOLDER`) so it can be cached and
 * coalesced across viewers exactly like a conventional rendition — this is
 * the one place that turns it back into a playable response for THIS
 * specific viewer, stamping their own token into every URI right before it
 * leaves the Worker. Callers gate this on `isLlRendition`
 * (`origin === origins.ll`) rather than calling it unconditionally: a
 * conventional body never contains the placeholder, so calling this on one
 * would just be a wasted read-and-rebuild of every conventional response.
 */
async function stampLlToken(
  response: Response,
  credential: { param: string; value: string },
): Promise<Response> {
  const text = await response.text();
  const headers = new Headers(response.headers);
  return new Response(applyLlRenditionCredential(text, credential.param, credential.value), {
    status: response.status,
    headers,
  });
}

interface FetchedPlaylist {
  status: number;
  headers: Headers;
  body: ArrayBuffer;
}

interface CoalescedFetch {
  result: FetchedPlaylist;
  /**
   * True for exactly one of the callers sharing a given cache key: the one
   * whose call actually started the origin fetch, as opposed to one that
   * arrived while it was already in flight and is only awaiting the same
   * promise. `handlePlaylistRequest` uses this to decide who populates the
   * shared cache -- see that call site for why every OTHER caller doing the
   * same `cache.put` would be pure waste.
   */
  isProducer: boolean;
}

/**
 * One rendition's origin fetch, shared by every concurrent caller asking for
 * the SAME cache key.
 *
 * WHY THIS EXISTS. When a rendition's cached entry expires, every viewer
 * polling that rung can observe `cache.match` as empty before the FIRST of
 * them finishes populating it — at party scale that is hundreds of
 * synchronized viewers each starting their own origin fetch in the same few
 * milliseconds, which is exactly the fan-in this Worker exists to collapse.
 * Coalescing concurrent misses onto one in-flight promise (keyed by the same
 * cache key `index.ts` already uses, never the token) turns that burst back
 * into one real fetch; only THIS isolate's concurrent requests share it,
 * since Cloudflare can and does run more than one isolate for a busy Worker,
 * but that is still a real reduction and it composes with, rather than
 * replaces, the cache above.
 *
 * ONE LOG LINE PER SHARED FETCH, NOT ONE PER WAITER. Both the success and
 * failure logging happen INSIDE the shared promise, exactly once no matter
 * how many callers are awaiting it -- an earlier version logged from each
 * caller's own `try`/`catch` around `await`, which meant a synchronized
 * expiry with hundreds of coalesced waiters produced hundreds of identical
 * `hlsEdge.originError` / `hlsEdge.originRejected` lines for what was
 * genuinely one origin round trip (Farol flagged this as a MEDIUM
 * performance issue). A caller that needs to know the outcome still can --
 * the returned/thrown value carries it -- it just does not ALSO log it
 * again.
 *
 * Returns a plain buffered record rather than a `Response` because a
 * `Response` body can only be read once: every awaiter needs its own copy of
 * the bytes to build its own reply and, separately, its own cache-store
 * candidate.
 */
const inFlightRenditionFetches = new Map<string, Promise<FetchedPlaylist>>();

/**
 * `LlPlaylistOrigin` holds a per-session codec cache (`ll-playlist-origin.ts`)
 * that is only worth anything if the SAME instance answers every request
 * this isolate serves -- constructing a fresh one per `fetch()` call, the
 * way `ApiPlaylistOrigin` above is (harmless for it: it holds no state)
 * would silently throw that cache away on every single request. Recreated
 * only if `LL_ORIGIN_BASE` itself changes, which in practice never happens
 * mid-isolate-lifetime -- Workers bindings are fixed for an isolate -- but
 * checking costs nothing and avoids a stale value surviving a config change
 * some future test or `wrangler dev --local` reload makes.
 */
let llOriginSingleton: LlPlaylistOrigin | null = null;
let llOriginSingletonBase: string | undefined;
let llOriginSingletonKey: string | undefined;
let llOriginSingletonHoldBackParts: number | undefined;

function getLlOrigin(
  originBase: string | undefined,
  timeoutMs: number,
  originKey: string | undefined,
  partHoldBackParts: number | undefined,
): LlPlaylistOrigin {
  if (
    !llOriginSingleton ||
    llOriginSingletonBase !== originBase ||
    llOriginSingletonKey !== originKey ||
    llOriginSingletonHoldBackParts !== partHoldBackParts
  ) {
    llOriginSingleton = new LlPlaylistOrigin(originBase, timeoutMs, originKey, partHoldBackParts);
    llOriginSingletonBase = originBase;
    llOriginSingletonKey = originKey;
    llOriginSingletonHoldBackParts = partHoldBackParts;
  }
  return llOriginSingleton;
}

/**
 * `LL_PART_HOLD_BACK_PARTS`, or `undefined` for anything that is not a finite
 * number — an empty string, a typo, a negative. `undefined` means
 * "`ll-playlist.js`'s default", never "zero", which is the one reading that
 * would put an invalid `PART-HOLD-BACK` in front of a live audience.
 */
function parsePartHoldBackParts(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The `beforeReveal` hook for a rendition playlist: warm the newest segments
 * it lists into this colo's cache before any viewer can learn they exist.
 * Inert unless `SEGMENT_PREWARM` is "on" (off by default: it sits on the
 * playlist path, so it ships dark and is turned on only once segments at the
 * edge are proven), this Worker serves segments (`LIVE_SEGMENTS` bound and
 * `HLS_SEGMENT_TOKEN_SECRET` set), and the playlist points at this host.
 */
function segmentWarmer(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  channelId: string,
  rung: string,
): ((body: ArrayBuffer) => Promise<void>) | undefined {
  if (env.SEGMENT_PREWARM !== "on" || !env.LIVE_SEGMENTS || !env.HLS_SEGMENT_TOKEN_SECRET) {
    return undefined;
  }
  return async (body) => {
    const started = Date.now();
    const text = new TextDecoder().decode(body);
    if (!text.includes("/api/voice/hls-segment/")) {
      return;
    }
    const { attempted, timedOut } = await warmNewSegments(
      text,
      request.url,
      env,
      caches.default,
      ctx,
    );
    if (attempted > 0) {
      logEvent("hlsEdge.segmentPrewarm", {
        channelId,
        rung,
        segments: attempted,
        durationMs: Date.now() - started,
        timedOut,
      });
    }
  };
}

async function fetchRenditionCoalesced(
  cacheKeyUrl: string,
  origin: PlaylistOrigin,
  ctx: ExecutionContext,
  req: {
    channelId: string;
    startedAt: string;
    rung: string;
    token: string;
    /**
     * Runs on a fresh 200 body BEFORE it is shared with anyone (see
     * `warmNewSegments` in `segment-media.ts`, "WARM BEFORE REVEAL"). Bounded
     * by the callee; a failure here never fails the playlist.
     */
    beforeReveal?: (body: ArrayBuffer) => Promise<void>;
  },
): Promise<CoalescedFetch> {
  const startTime = Date.now();
  const produce = async (): Promise<FetchedPlaylist> => {
    let response: Response;
    let body: ArrayBuffer;
    try {
      response = await origin.fetchPlaylist(req);
      body = await response.arrayBuffer();
    } catch {
      // Logged HERE, once, for every waiter sharing this fetch -- see the
      // doc comment above.
      logEvent("hlsEdge.originError", { channelId: req.channelId, rung: req.rung });
      throw new Error("origin fetch failed");
    }
    if (response.ok && req.beforeReveal) {
      try {
        await req.beforeReveal(body);
      } catch {
        // Warming is an optimisation; the playlist is served regardless.
      }
    }
    if (response.ok) {
      logEvent("hlsEdge.originFetch", {
        channelId: req.channelId,
        rung: req.rung,
        bytes: body.byteLength,
        durationMs: Date.now() - startTime,
      });
    } else {
      logEvent("hlsEdge.originRejected", {
        channelId: req.channelId,
        rung: req.rung,
        status: response.status,
      });
    }
    return { status: response.status, headers: response.headers, body };
  };

  // BOTH HALVES OF THE 2026-09-15 FIX (see `coalesced-fetch.js`'s header).
  // `keepAlive` extends the PRODUCING request's context past its own
  // response, so the fetch every joiner is sharing actually survives long
  // enough to answer them -- without it, the producer returning is what
  // cancelled the fetch and turned a healthy origin into five 502s. The
  // bounded, detachable join inside `coalesceFetch` is the other half, for
  // the joiners of a producer that dies anyway (a viewer navigating away
  // takes its context with it whatever this Worker does).
  return coalesceFetch(inFlightRenditionFetches, cacheKeyUrl, produce, {
    keepAlive: (promise) => ctx.waitUntil(promise),
    onDetach: ({ reason, attempt }) => {
      logEvent("hlsEdge.originJoinDetached", {
        channelId: req.channelId,
        rung: req.rung,
        reason,
        attempt,
      });
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const preflight = handleCorsPreflight(env, request);
    if (preflight) {
      return preflight;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withCors(text(405, "Method not allowed"), env, request);
    }

    const url = new URL(request.url);

    // CONVENTIONAL SEGMENT BYTES (`segment-media.ts`): its own path, its own
    // capability, R2 behind the colo cache. Only reachable once the API is
    // told to point segment lines here (`LIVE_HLS_SEGMENT_BASE_URL`).
    const segment = parseSegmentPath(url.pathname);
    if (segment) {
      const segmentResponse = await handleSegmentRequest(
        request,
        env,
        caches.default,
        ctx,
        segment,
      );
      return withCors(segmentResponse, env, request);
    }

    const match = parsePlaylistPath(url.pathname);
    if (!match) {
      return withCors(json(404, { error: "Not found" }), env, request);
    }

    // The conventional origin: ask the API. See `playlist-origin.ts` for the
    // seam a future R2-backed implementation swaps in through. Alongside it,
    // task L2.2's LL origin -- ready only when `LL_ORIGIN_BASE` is set; see
    // `ll-playlist-origin.ts` and the `Env.LL_ORIGIN_BASE` doc comment above.
    const apiOrigin = new ApiPlaylistOrigin(env.ORIGIN_BASE, UPSTREAM_TIMEOUT_MS);
    const llOrigin = getLlOrigin(
      env.LL_ORIGIN_BASE,
      UPSTREAM_TIMEOUT_MS,
      env.LL_ORIGIN_KEY,
      parsePartHoldBackParts(env.LL_PART_HOLD_BACK_PARTS),
    );

    // THE LL MEDIA ROUTE (task L2.3, `ll-media.ts`): a fourth path segment
    // means the caller is asking for the BYTES an LL playlist's own URI
    // named (`.../:rung/part-164.m4s`), not for a playlist. Dispatched here
    // rather than inside `handlePlaylistRequest` because it is a different
    // kind of response with a different cache lifetime (a year, immutable,
    // versus two seconds) -- the one thing the two share is the credential
    // check, which is why THAT is the part that moved into its own module
    // (`viewer-access.ts`) instead.
    if (match.media !== undefined && match.rung !== undefined) {
      const mediaResponse = await handleLlMediaRequest(
        request,
        llOrigin,
        caches.default,
        ctx,
        env,
        partyPassRevocationGate,
        {
          channelId: match.channelId,
          startedAt: match.startedAt,
          rung: match.rung,
          name: match.media,
        },
      );
      return withCors(mediaResponse, env, request);
    }

    const response = await handlePlaylistRequest(
      request,
      { api: apiOrigin, ll: llOrigin },
      ctx,
      env,
      match.channelId,
      match.startedAt,
      match.rung,
    );
    return withCors(response, env, request);
  },
};

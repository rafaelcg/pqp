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
 * TWO ROUTES, TWO CACHING RULES, because the two playlist bodies are not the
 * same kind of thing:
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
 *
 * WHAT STAYS AUTHORITATIVE, AND THE ONE THING THAT DOES NOT. The token check
 * (signature, expiry, channel, session) runs in THIS Worker, on every
 * request, using the same HMAC scheme as `hls-viewer-token.ts`
 * (`./hls-viewer-token.js`) — an invalid or expired token never reaches the
 * cache or the origin.
 *
 * REVOCATION IS THE EXCEPTION, AND IT IS WEAKER THAN A SINGLE VIEWER'S OWN
 * POLL INTERVAL WOULD SUGGEST. A ban or a lost VIEW permission is enforced by
 * `hls-revocation.ts`, an in-memory set that exists ONLY on the API process —
 * this Worker has no way to consult it, and never tries to. Without the
 * cache, that gap is bounded by "the next request THIS VIEWER makes", a
 * couple of seconds. WITH the cache, it is bounded by how long the SHARED
 * cache entry for that rung stays populated, which is refreshed by ANY valid
 * viewer's request, not particularly the revoked one's. During an active
 * party on a popular rung, that is effectively "as long as the party runs":
 * a banned or kicked viewer can keep receiving a live playlist and its
 * segment URLs for as long as other viewers keep the cache warm, because a
 * cache HIT never reaches the origin at all. This is a real, deliberate
 * trade-off of collapsing N viewers into one origin fetch — there is no way
 * to keep that collapse AND re-check each individual viewer's standing on
 * every request, since the second thing is what the first thing removes.
 * Flagged for explicit sign-off before this ships to production; see
 * `docs/plans/RELOAD_STORM.md` and `README.md` "What this Worker does NOT
 * make faster".
 */

import {
  HLS_VIEWER_TOKEN_PARAM,
  describeHlsViewerToken,
  verifyHlsViewerToken,
} from "./hls-viewer-token.js";
import {
  HLS_PARTY_PASS_PARAM,
  describeHlsPartyPass,
  verifyHlsPartyPass,
} from "./hls-party-pass.js";
import { parsePlaylistPath } from "./playlist-route.js";
import { ApiPlaylistOrigin, type PlaylistOrigin } from "./playlist-origin.js";
import { handleCorsPreflight, withCors } from "./cors.js";
import { logEvent } from "./log.js";

export interface Env {
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
   * Optional revocation hook for party-pass holders, see `isPartyPassRevoked`
   * below. Unbound today (no KV namespace is provisioned) -- see the TODO on
   * that function.
   */
  HLS_REVOKED_USERS?: KVNamespace;
  /** Comma-separated allowlist. Unset: every origin is echoed back (see cors.ts). */
  CORS_ALLOWED_ORIGINS?: string;
  // ALWAYS-ON (not yet built, see playlist-origin.ts and
  // docs/plans/ALWAYS_ON.md task A1.x): a future R2-backed PlaylistOrigin
  // would add its own bindings here (an R2Bucket, a DurableObjectNamespace).
  // Nothing reads them yet — see the commented placeholders in
  // wrangler.jsonc for why they are not declared until something does.
}

/**
 * TODO(party pass revocation): `hls-revocation.ts` on the API is an
 * in-memory set that lives only on that process -- this Worker has no path
 * to it, and a party pass (unlike `?t=`) can stay valid for up to
 * `LIVE_HLS_PARTY_PASS_MAX_TTL_MS` (6 h) after someone is banned or loses
 * VIEW. This function is the hook a real fix would hang off: given a KV
 * binding (`HLS_REVOKED_USERS`, not yet provisioned -- see the commented
 * placeholder in wrangler.jsonc) written to BY `hls-revocation.ts` on every
 * eviction (`userId` -> revoked-at timestamp, TTL'd to the party-pass
 * ceiling so the key expires on its own), this would check it before
 * honoring a party pass.
 *
 * TWO DIFFERENT KINDS OF "NO ANSWER", TWO DIFFERENT DEFAULTS. An UNCONFIGURED
 * binding (the only state that exists today -- nothing is provisioned) fails
 * OPEN: "not revoked", the same fail-open-on-unconfigured shape as
 * `CORS_ALLOWED_ORIGINS`, because the alternative would turn "operator has
 * not set up a KV namespace" into "the party pass feature silently does
 * nothing", which is a worse failure to debug than "revocation on a party
 * pass is best-effort" is to live with. A CONFIGURED binding that THROWS on
 * read is different: an operator who bound this namespace is telling this
 * Worker revocation matters to them, and a transient KV error is not the
 * same claim as "nothing is wired up" -- so once bound, a read failure fails
 * CLOSED, refusing the party pass for that one request (Farol flagged the
 * unconditional fail-open here as a HIGH). The caller already has a
 * fallback: the shared rendition cache, or the short-lived `?t=`, either of
 * which still works on a transient KV hiccup. `hlsEdge.partyPassRevocationCheckError`
 * says how often this actually happens; it should be rare, since Cloudflare
 * KV reads are normally fast and reliable from a colo.
 *
 * CACHED, NOT READ ON EVERY POLL. Without this, a viewer whose `?t=` has
 * expired pays one KV read per playlist poll (every 2-4 s) for the rest of
 * the party -- at a synchronized-expiry event that is hundreds of reads a
 * second landing on KV instead of the shared Cache API hit this whole Worker
 * exists to serve (Farol flagged this as a MEDIUM performance regression).
 * `PARTY_PASS_REVOCATION_CACHE_TTL_MS` bounds how stale a cached "not
 * revoked" answer can be -- 30 s, far tighter than the multi-hour exposure a
 * party pass already accepts, so caching this does not meaningfully widen
 * the trade-off already documented above; it removes an amplifier from it. A
 * REVOKED result is also cached, for the same window: a moderator does not
 * need this Worker to notice a ban within milliseconds, only quickly enough
 * that "revocation on a party pass is best-effort" stays true.
 */
const PARTY_PASS_REVOCATION_CACHE_TTL_MS = 30_000;
const PARTY_PASS_REVOCATION_CACHE_MAX_ENTRIES = 10_000;
const partyPassRevocationCache = new Map<string, { revoked: boolean; at: number }>();

async function isPartyPassRevoked(env: Pick<Env, "HLS_REVOKED_USERS">, userId: string): Promise<boolean> {
  if (!env.HLS_REVOKED_USERS) {
    return false;
  }
  const now = Date.now();
  const cached = partyPassRevocationCache.get(userId);
  if (cached && now - cached.at < PARTY_PASS_REVOCATION_CACHE_TTL_MS) {
    return cached.revoked;
  }
  let revoked: boolean;
  try {
    revoked = (await env.HLS_REVOKED_USERS.get(userId)) !== null;
  } catch {
    // Bound but unreachable: fail CLOSED (see the doc comment above for why
    // this differs from the unconfigured case). Not cached -- a real outage
    // should not pin every request to "revoked" for the next 30 s once the
    // namespace recovers.
    logEvent("hlsEdge.partyPassRevocationCheckError", {});
    return true;
  }
  if (partyPassRevocationCache.size >= PARTY_PASS_REVOCATION_CACHE_MAX_ENTRIES) {
    // `userId` only ever reaches here after a valid party-pass signature
    // check, so this is bounded by real distinct viewers, not an
    // attacker-controlled path segment the way `rejectionLog`'s key is --
    // still, evicting the oldest entry on overflow costs nothing and keeps
    // this from growing without bound across a very long-running isolate.
    const oldestKey = partyPassRevocationCache.keys().next().value;
    if (oldestKey !== undefined) {
      partyPassRevocationCache.delete(oldestKey);
    }
  }
  partyPassRevocationCache.set(userId, { revoked, at: now });
  return revoked;
}

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
 * `X-HLS-Edge-Cache: 401`-shaped rejections are rate-limited the same way
 * `logHlsPlaylistRejection` is on the origin, so a broken client cannot turn
 * its own bug into a log write amplifier.
 *
 * `channelId` is an attacker-controlled path segment (up to 64 characters,
 * `playlist-route.ts`'s own bound, not this map's), so an attacker cycling
 * through distinct channel ids on every request would otherwise grow this
 * map forever — nothing ever deleted an entry, only added or updated one.
 * Two bounds, in `logRejection` below: an ACTIVE sweep drops every entry
 * whose `REJECTION_LOG_WINDOW_MS` has already closed (so ordinary traffic
 * settles back near zero entries once a flood stops), throttled to once per
 * `REJECTION_LOG_SWEEP_INTERVAL_MS` rather than on every new key — a full
 * scan is O(map size), and running it on every previously-unseen key would
 * turn a sustained stream of unique invalid requests into its own CPU cost
 * on the request hot path, which is exactly the kind of amplification this
 * whole rejection log exists to avoid elsewhere. `REJECTION_LOG_MAX_ENTRIES`
 * is the hard ceiling in between sweeps, checked (cheaply, O(1)) on every
 * new key regardless of the throttle: past it, the oldest entry (by
 * insertion order) is evicted — an approximation of LRU, not a precise one,
 * which is enough for a hostile-traffic bound on a log dedupe table, not a
 * cache whose eviction policy anyone depends on.
 */
const REJECTION_LOG_WINDOW_MS = 30_000;
const REJECTION_LOG_MAX_ENTRIES = 1_000;
const REJECTION_LOG_SWEEP_INTERVAL_MS = 10_000;
const rejectionLog = new Map<string, { at: number; suppressed: number }>();
let rejectionLogLastSweptAt = 0;

function logRejection(
  channelId: string,
  rung: string | undefined,
  reason: string,
): void {
  const key = `${channelId}:${rung ?? "-"}:${reason}`;
  const now = Date.now();
  const seen = rejectionLog.get(key);
  if (seen && now - seen.at < REJECTION_LOG_WINDOW_MS) {
    seen.suppressed += 1;
    return;
  }
  logEvent("hlsEdge.playlistRejected", {
    channelId,
    rung: rung ?? null,
    reason,
    suppressed: seen?.suppressed ?? 0,
  });
  if (!seen) {
    // Active expiry, throttled: at most one full scan per
    // `REJECTION_LOG_SWEEP_INTERVAL_MS`, regardless of how many new keys
    // arrive in between -- see the doc comment above for why an unthrottled
    // scan on every new key would itself be a hot-path cost.
    if (now - rejectionLogLastSweptAt >= REJECTION_LOG_SWEEP_INTERVAL_MS) {
      for (const [existingKey, entry] of rejectionLog) {
        if (now - entry.at >= REJECTION_LOG_WINDOW_MS) {
          rejectionLog.delete(existingKey);
        }
      }
      rejectionLogLastSweptAt = now;
    }
    if (rejectionLog.size >= REJECTION_LOG_MAX_ENTRIES) {
      // Still over the cap after expiry (a sustained flood of genuinely
      // fresh unique keys): fall back to evicting the oldest by insertion
      // order, an approximation of LRU that is enough for a hostile-traffic
      // bound on a log dedupe table, not a cache anyone depends on for
      // eviction precision.
      const oldestKey = rejectionLog.keys().next().value;
      if (oldestKey !== undefined) {
        rejectionLog.delete(oldestKey);
      }
    }
  }
  rejectionLog.set(key, { at: now, suppressed: 0 });
}

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

/** 401 for "not a valid credential at all", 403 for "valid, but not for this resource". */
function statusForRejection(reason: string): number {
  return reason === "wrong-channel" || reason === "wrong-session" ? 403 : 401;
}

/** The cache-key request for a rendition: path only, no query — the token never varies the body. */
function cacheKeyRequest(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

async function handlePlaylistRequest(
  request: Request,
  origin: PlaylistOrigin,
  ctx: ExecutionContext,
  env: Pick<Env, "HLS_VIEWER_TOKEN_SECRET" | "HLS_PARTY_PASS_SECRET" | "HLS_REVOKED_USERS">,
  channelId: string,
  startedAt: string,
  rung: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get(HLS_VIEWER_TOKEN_PARAM);
  const secret = env.HLS_VIEWER_TOKEN_SECRET ?? null;
  const expected = { channelId, startedAt: Number(startedAt) };

  let verified = await verifyHlsViewerToken(token, expected, secret);
  // The party pass gates ONLY the rendition route (`rung` set). The
  // session/master route below is always forwarded fresh with the caller's
  // own token and never cached, so there is nothing for the pass's longer
  // life to buy there -- see the module doc comment and `mintHlsPartyPass`'s
  // in `hls-viewer-token.ts`.
  let usedPartyPass = false;
  if (!verified && rung) {
    const partyPass = url.searchParams.get(HLS_PARTY_PASS_PARAM);
    const partySecret = env.HLS_PARTY_PASS_SECRET ?? null;
    const passVerified = await verifyHlsPartyPass(partyPass, expected, partySecret);
    if (passVerified && !(await isPartyPassRevoked(env, passVerified.userId))) {
      verified = passVerified;
      usedPartyPass = true;
    }
  }
  if (!verified) {
    // Describe whichever credential was actually offered: the token if
    // present (the common case, and what most rejections are about), the
    // party pass only when the caller sent NO token at all.
    const reason = token
      ? ((await describeHlsViewerToken(token, expected, secret)) ?? "malformed")
      : ((await describeHlsPartyPass(
          url.searchParams.get(HLS_PARTY_PASS_PARAM),
          expected,
          env.HLS_PARTY_PASS_SECRET ?? null,
        )) ?? "malformed");
    logRejection(channelId, rung, reason);
    return json(statusForRejection(reason), { error: "Unauthorized", reason });
  }

  if (!origin.ready) {
    logEvent("hlsEdge.originNotConfigured", { channelId, rung: rung ?? null });
    return text(503, "Origin not configured");
  }

  // The session/master URL: see the module doc comment for why this route is
  // always forwarded with the caller's OWN token and never cached. Gated on
  // `verified` above, which for this branch can only ever have come from
  // `t` (party pass is skipped when `rung` is unset), so `token` here is
  // never null.
  if (!rung) {
    let originResponse: Response;
    try {
      originResponse = await origin.fetchPlaylist({
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

  const cache = caches.default;
  const cacheKey = cacheKeyRequest(request);
  const cached = await safeCacheMatch(cache, cacheKey);
  if (cached) {
    noteCacheHit(channelId, rung);
    const headers = new Headers(cached.headers);
    headers.set("X-HLS-Edge-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  // A CACHE MISS NEEDS AN ORIGIN-VERIFIABLE TOKEN, AND A PARTY PASS IS NOT
  // ONE (`hls-viewer-token.ts`'s `verifyHlsViewerToken` cannot verify a
  // party pass, by construction). A viewer authorised here ONLY by a party
  // pass -- no `t` at all, or one that has since expired -- cannot make this
  // Worker mint a fresh origin fetch on their own. In practice that is a
  // narrow window: the shared cache above is refilled by ANY other valid
  // viewer of the same rung, and a live party rarely has every viewer's
  // short-lived token expire at once. When it does, the honest answer is a
  // retryable miss, not a 401 -- the caller is not unauthorized, there is
  // just no fresh copy this request can produce. `voice.hlsPlaylistRejected`
  // logs "expired" from real 401s; this gets its own counter so the two are
  // never confused when reading a dashboard.
  if (!token) {
    logEvent("hlsEdge.partyPassMissWithoutToken", { channelId, rung });
    return text(503, "Playlist not cached; retry shortly");
  }

  let fetched: FetchedPlaylist;
  let isProducer: boolean;
  try {
    const coalesced = await fetchRenditionCoalesced(cacheKey.url, origin, {
      channelId,
      startedAt,
      rung,
      token,
    });
    fetched = coalesced.result;
    isProducer = coalesced.isProducer;
  } catch {
    // Already logged once, inside the shared fetch, regardless of how many
    // callers are awaiting it -- see `fetchRenditionCoalesced`'s doc comment.
    return text(502, "Origin fetch failed");
  }

  if (fetched.status < 200 || fetched.status >= 300) {
    if (usedPartyPass && (fetched.status === 401 || fetched.status === 403)) {
      // The caller's OWN credential (the party pass) is still valid; it is
      // the `t` this Worker had to forward instead that the origin refused
      // (expired, most likely -- see the block above). Reporting the
      // origin's raw 401 would tell a legitimately-partied viewer they are
      // unauthorized, which they are not. Same shape as the no-token case
      // above: retryable, not a rejection, and its own counter.
      logEvent("hlsEdge.partyPassOriginMissRefused", {
        channelId,
        rung,
        originStatus: fetched.status,
      });
      return text(503, "Playlist not cached; retry shortly");
    }
    // Never cache non-200 — a stream that has not started yet or has just
    // ended must not get frozen into "not found" for every viewer for the
    // rest of the cache window. `hlsEdge.originRejected` is already logged
    // once, inside the shared fetch.
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
  return response;
}

/**
 * `cache.match` failing (a transient Cache API error) must read as a MISS,
 * not as a thrown error that fails the whole request — this cache is an
 * optimization, and losing it for one request is a much smaller problem than
 * turning a Cache API hiccup into a 500 for every viewer of a rung.
 */
async function safeCacheMatch(cache: Cache, key: Request): Promise<Response | undefined> {
  try {
    return await cache.match(key);
  } catch {
    logEvent("hlsEdge.cacheReadError", {});
    return undefined;
  }
}

/**
 * Same reasoning in the other direction: a failed `cache.put` must not
 * become an unhandled rejection under `ctx.waitUntil` (which Cloudflare
 * treats as a Worker error) when the response it was populating the cache
 * FOR has already been served successfully. Losing one write just means the
 * next request repeats the origin fetch this write would have saved it.
 */
async function safeCachePut(cache: Cache, key: Request, response: Response): Promise<void> {
  try {
    await cache.put(key, response);
  } catch {
    logEvent("hlsEdge.cacheWriteError", {});
  }
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

async function fetchRenditionCoalesced(
  cacheKeyUrl: string,
  origin: PlaylistOrigin,
  req: { channelId: string; startedAt: string; rung: string; token: string },
): Promise<CoalescedFetch> {
  const existing = inFlightRenditionFetches.get(cacheKeyUrl);
  if (existing) {
    return { result: await existing, isProducer: false };
  }
  const startTime = Date.now();
  const promise = (async (): Promise<FetchedPlaylist> => {
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
  })();
  inFlightRenditionFetches.set(cacheKeyUrl, promise);
  try {
    return { result: await promise, isProducer: true };
  } finally {
    inFlightRenditionFetches.delete(cacheKeyUrl);
  }
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
    const match = parsePlaylistPath(url.pathname);
    if (!match) {
      return withCors(json(404, { error: "Not found" }), env, request);
    }

    // Today's only `PlaylistOrigin`: ask the API. See `playlist-origin.ts`
    // for the seam a future R2-backed implementation swaps in through.
    const origin = new ApiPlaylistOrigin(env.ORIGIN_BASE, UPSTREAM_TIMEOUT_MS);

    const response = await handlePlaylistRequest(
      request,
      origin,
      ctx,
      env,
      match.channelId,
      match.startedAt,
      match.rung,
    );
    return withCors(response, env, request);
  },
};

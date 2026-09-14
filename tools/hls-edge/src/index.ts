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
import {
  PartyPassRevocationGate,
  partyPassRequiresKvInProduction,
} from "./party-pass-revocation.js";
import { parsePlaylistPath } from "./playlist-route.js";
import { ApiPlaylistOrigin, type PlaylistOrigin } from "./playlist-origin.js";
import { LlPlaylistOrigin } from "./ll-playlist-origin.js";
import { applyLlRenditionToken } from "./ll-playlist.js";
import { playlistOriginKindForRung } from "./ll-state.js";
import { handleCorsPreflight, withCors } from "./cors.js";
import { logEvent } from "./log.js";
import { handleBlockingReload, parseBlockingReloadParams } from "./hls-blocking-reload.js";

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
  return reason === "wrong-channel" ||
    reason === "wrong-session" ||
    reason === "revoked" ||
    reason === "party-pass-kv-unconfigured"
    ? 403
    : 401;
}

/** The cache-key request for a rendition: path only, no query — the token never varies the body. */
function cacheKeyRequest(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

async function handlePlaylistRequest(
  request: Request,
  origins: { api: PlaylistOrigin; ll: LlPlaylistOrigin },
  ctx: ExecutionContext,
  env: Pick<Env, "HLS_VIEWER_TOKEN_SECRET" | "HLS_PARTY_PASS_SECRET" | "HLS_REVOKED_USERS" | "ENVIRONMENT">,
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
  // Set only on the party-pass path, so the final rejection block below can
  // report the REAL reason a well-formed pass was refused -- without this,
  // a revoked-but-otherwise-valid pass fell through to `describeHlsPartyPass`,
  // which knows nothing about revocation and answered "malformed" for a
  // pass that was not malformed at all.
  let partyPassRejectReason: "revoked" | "party-pass-kv-unconfigured" | null = null;
  if (!verified && rung) {
    const partyPass = url.searchParams.get(HLS_PARTY_PASS_PARAM);
    const partySecret = env.HLS_PARTY_PASS_SECRET ?? null;
    const passVerified = await verifyHlsPartyPass(partyPass, expected, partySecret);
    if (passVerified) {
      if (partyPassRequiresKvInProduction(env)) {
        // See README.md "Enabling in production": a party pass is a 6 h
        // credential this Worker alone checks, and in production that is
        // too wide a gap to accept with no KV denylist behind it at all --
        // refuse outright rather than silently falling open.
        partyPassRejectReason = "party-pass-kv-unconfigured";
      } else {
        const { revoked, kvError } = await partyPassRevocationGate.check(
          env.HLS_REVOKED_USERS,
          passVerified.userId,
          channelId,
          passVerified.issuedAt,
        );
        if (kvError) {
          logEvent("hlsEdge.partyPassRevocationCheckError", { channelId });
        }
        if (revoked) {
          partyPassRejectReason = "revoked";
        }
      }
      if (!partyPassRejectReason) {
        verified = passVerified;
        usedPartyPass = true;
      }
    }
  }
  if (!verified) {
    // Describe whichever credential was actually offered: a revoked/refused
    // party pass reports that outcome directly (it verified fine as a
    // signature; the KV check is what said no); otherwise the token if
    // present (the common case, and what most rejections are about), the
    // party pass only when the caller sent NO token at all.
    const reason =
      partyPassRejectReason ??
      (token
        ? ((await describeHlsViewerToken(token, expected, secret)) ?? "malformed")
        : ((await describeHlsPartyPass(
            url.searchParams.get(HLS_PARTY_PASS_PARAM),
            expected,
            env.HLS_PARTY_PASS_SECRET ?? null,
          )) ?? "malformed"));
    logRejection(channelId, rung, reason);
    return json(statusForRejection(reason), { error: "Unauthorized", reason });
  }

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
    // LL-HLS multivariant playlist (task L2.2, `ll-playlist-origin.ts`).
    // Tried FIRST, straight against the remux origin, never the API: only
    // an LL session's master needs to look any different from what the API
    // already answers (`docs/plans/LL_HLS.md` §4, "the master playlist
    // lists the LL rung beside the 720p30 rung" — full mixing with the
    // conventional ladder is a later task; for now an LL session's master
    // is LL-only). `fetchMultivariantPlaylist` returns `null` for every
    // failure mode -- `LL_ORIGIN_BASE` unset, this specific session isn't
    // LL, the origin is unreachable, a malformed `state.json` or init
    // segment -- so a bug or an outage in the LL path can only ever fall
    // through to the EXACT byte-for-byte-unchanged API forward below, never
    // turn a conventional session's master into an error. See
    // `ll-playlist-origin.ts`'s header, "FAILS TOWARD...".
    if (origins.ll.ready) {
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
      // path skips the API. Refused outright rather than falling through to
      // the API forward below: that forward carries the SAME token, so it
      // would be refused there too, and silently downgrading a revoked
      // viewer to non-LL playback instead of rejecting them would be its
      // own kind of leak.
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
      const llResponse = await origins.ll.fetchMultivariantPlaylist(channelId, startedAt, token!);
      if (llResponse) {
        const headers = new Headers(llResponse.headers);
        headers.set("X-HLS-Edge-Cache", "BYPASS");
        headers.set("X-HLS-Edge-Mode", "ll");
        return new Response(llResponse.body, { status: llResponse.status, headers });
      }
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
      () =>
        fetchRenditionCoalesced(cacheKeyRequest(request).url, origin, {
          channelId,
          startedAt,
          rung,
          token: token!,
        }),
      logEvent,
      { channelId, rung },
      request.signal,
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
      return isLlRendition ? await stampLlToken(blockingResponse, token!) : blockingResponse;
    }
  }

  const cache = caches.default;
  const cacheKey = cacheKeyRequest(request);
  const cached = await safeCacheMatch(cache, cacheKey);
  if (cached) {
    noteCacheHit(channelId, rung);
    const headers = new Headers(cached.headers);
    headers.set("X-HLS-Edge-Cache", "HIT");
    const response = new Response(cached.body, { status: cached.status, headers });
    return isLlRendition ? await stampLlToken(response, token!) : response;
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
  return isLlRendition ? await stampLlToken(response, token!) : response;
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
async function stampLlToken(response: Response, token: string): Promise<Response> {
  const text = await response.text();
  const headers = new Headers(response.headers);
  return new Response(applyLlRenditionToken(text, token), { status: response.status, headers });
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
 * FOR has already been served successfully.
 *
 * ONE RETRY, NOT ZERO. This is the producer's ONLY attempt at populating
 * the shared cache for this window (see "ONLY THE PRODUCER WRITES THE
 * CACHE" at the call site) — every OTHER caller sharing the coalesced fetch
 * already has its own copy of the bytes and returns successfully to its own
 * viewer regardless, so a bare `cache.put` failure was invisible to every
 * individual request while still meaning NOBODY populated the shared cache
 * for the rest of the window, undoing exactly the collapse this Worker
 * exists for. A transient Cache API error is the common failure shape here
 * (`cache.match` gets the identical treatment above), so one immediate
 * retry recovers most of them; `hlsEdge.cacheWriteError` now fires only
 * once BOTH attempts have failed, with `attempts: 2` to tell it apart from
 * a single-attempt failure if this ever needs a third try later.
 */
async function safeCachePut(cache: Cache, key: Request, response: Response): Promise<void> {
  try {
    await cache.put(key, response.clone());
    return;
  } catch {
    // fall through to the retry below
  }
  try {
    await cache.put(key, response);
  } catch {
    logEvent("hlsEdge.cacheWriteError", { attempts: 2 });
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

function getLlOrigin(originBase: string | undefined, timeoutMs: number): LlPlaylistOrigin {
  if (!llOriginSingleton || llOriginSingletonBase !== originBase) {
    llOriginSingleton = new LlPlaylistOrigin(originBase, timeoutMs);
    llOriginSingletonBase = originBase;
  }
  return llOriginSingleton;
}

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

    // The conventional origin: ask the API. See `playlist-origin.ts` for the
    // seam a future R2-backed implementation swaps in through. Alongside it,
    // task L2.2's LL origin -- ready only when `LL_ORIGIN_BASE` is set; see
    // `ll-playlist-origin.ts` and the `Env.LL_ORIGIN_BASE` doc comment above.
    const apiOrigin = new ApiPlaylistOrigin(env.ORIGIN_BASE, UPSTREAM_TIMEOUT_MS);
    const llOrigin = getLlOrigin(env.LL_ORIGIN_BASE, UPSTREAM_TIMEOUT_MS);

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

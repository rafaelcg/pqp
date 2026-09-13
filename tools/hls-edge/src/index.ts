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
 * THE SHAPE. This Worker's route is the SAME path shape as the origin's
 * (`/api/voice/hls-playlist/:channelId/:startedAt(/:rung)?`) — deliberately,
 * because `LIVE_HLS_PLAYLIST_BASE_URL` on the server (`hls-egress.ts`) just
 * prepends this Worker's origin to that same path, so a viewer's client makes
 * the exact request it always made, against a different host. See
 * `docs/WATCH_PARTY.md` "Playlists at the edge".
 *
 * TWO ROUTES, TWO RULES, because the two playlist bodies are not the same
 * kind of thing:
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
 * WHAT STAYS AUTHORITATIVE. The token check runs in THIS Worker, on every
 * request, using the same HMAC scheme as `hls-viewer-token.ts`
 * (`./hls-viewer-token.js`) — an invalid or expired token never reaches the
 * cache or the origin. What this Worker's cache does NOT know about is a ban
 * or a lost VIEW permission recorded after a token was minted
 * (`hls-revocation.ts`, origin-only, in-memory): that is bounded by how often
 * a REAL origin fetch happens for a given rung, which with this Worker in
 * front is once per `CACHE_TTL_SECONDS`, not once per viewer. That is the
 * same "worst case is one refresh interval" shape the origin's own comment on
 * `hls-viewer-token.ts` describes for its TTL — this Worker widens the
 * interval from "per viewer's own poll" to "per cache window", never removes
 * the check.
 */

import {
  HLS_VIEWER_TOKEN_PARAM,
  describeHlsViewerToken,
  verifyHlsViewerToken,
} from "./hls-viewer-token.js";
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
  /** Comma-separated allowlist. Unset: every origin is echoed back (see cors.ts). */
  CORS_ALLOWED_ORIGINS?: string;
}

/** Same shape as `HLS_PLAYLIST_PATH` in `server/src/api/index.ts`. */
const PLAYLIST_PATH =
  /^\/api\/voice\/hls-playlist\/([^/]{1,64})\/(\d{1,20})(?:\/([A-Za-z0-9]{1,16}))?$/;

/**
 * How long a rendition's playlist is shared across viewers. The egress
 * re-renders a live playlist roughly once a second per rendition
 * (`hls-playlist-proxy.ts`); 2 s keeps this Worker's copy no more stale than
 * a viewer's own poll interval already tolerates, while still collapsing
 * every request inside that window into one origin fetch.
 */
const CACHE_TTL_SECONDS = 2;

const UPSTREAM_TIMEOUT_MS = 8_000;

/** `X-HLS-Edge-Cache: 401`-shaped rejections are rate-limited the same way `logHlsPlaylistRejection` is on the origin, so a broken client cannot turn its own bug into a log write amplifier. */
const REJECTION_LOG_WINDOW_MS = 30_000;
const rejectionLog = new Map<string, { at: number; suppressed: number }>();

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

async function fetchWithTimeout(url: string, signalMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), signalMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The origin URL for one playlist request, same path shape, token attached. */
function originUrl(
  originBase: string,
  channelId: string,
  startedAt: string,
  rung: string | undefined,
  token: string,
): string {
  const path =
    `/api/voice/hls-playlist/${encodeURIComponent(channelId)}/${startedAt}` +
    (rung ? `/${encodeURIComponent(rung)}` : "");
  const url = new URL(path, originBase);
  url.searchParams.set(HLS_VIEWER_TOKEN_PARAM, token);
  return url.toString();
}

/** The cache-key request for a rendition: path only, no query — the token never varies the body. */
function cacheKeyRequest(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

async function handlePlaylistRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  channelId: string,
  startedAt: string,
  rung: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get(HLS_VIEWER_TOKEN_PARAM);
  const secret = env.HLS_VIEWER_TOKEN_SECRET ?? null;
  const expected = { channelId, startedAt: Number(startedAt) };

  const verified = await verifyHlsViewerToken(token, expected, secret);
  if (!verified) {
    const reason = (await describeHlsViewerToken(token, expected, secret)) ?? "malformed";
    logRejection(channelId, rung, reason);
    return json(statusForRejection(reason), { error: "Unauthorized", reason });
  }

  if (!env.ORIGIN_BASE) {
    logEvent("hlsEdge.originNotConfigured", { channelId, rung: rung ?? null });
    return text(503, "Origin not configured");
  }

  // The session/master URL: see the module doc comment for why this route is
  // always forwarded with the caller's OWN token and never cached.
  if (!rung) {
    let originResponse: Response;
    try {
      originResponse = await fetchWithTimeout(
        originUrl(env.ORIGIN_BASE, channelId, startedAt, undefined, token!),
        UPSTREAM_TIMEOUT_MS,
      );
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
  const cached = await cache.match(cacheKey);
  if (cached) {
    noteCacheHit(channelId, rung);
    const headers = new Headers(cached.headers);
    headers.set("X-HLS-Edge-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const upstreamUrl = originUrl(env.ORIGIN_BASE, channelId, startedAt, rung, token!);
  const startTime = Date.now();
  let originResponse: Response;
  try {
    originResponse = await fetchWithTimeout(upstreamUrl, UPSTREAM_TIMEOUT_MS);
  } catch {
    logEvent("hlsEdge.originError", { channelId, rung });
    return text(502, "Origin fetch failed");
  }

  if (!originResponse.ok) {
    // Never cache non-200 — a stream that has not started yet or has just
    // ended must not get frozen into "not found" for every viewer for the
    // rest of the cache window.
    logEvent("hlsEdge.originRejected", {
      channelId,
      rung,
      status: originResponse.status,
    });
    const headers = new Headers(originResponse.headers);
    headers.set("X-HLS-Edge-Cache", "SKIP");
    return new Response(originResponse.body, {
      status: originResponse.status,
      headers,
    });
  }

  const body = await originResponse.arrayBuffer();
  const headers = new Headers(originResponse.headers);
  // The origin sets `private, no-store` (it has to: the same URL is also
  // Bearer-reachable, per-viewer). This Worker's cache is the one place that
  // is deliberately NOT per-viewer — the body is identical for every valid
  // viewer of this rung in this window — so it overrides that directive on
  // purpose rather than failing to cache at all.
  headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}`);

  const toCache = new Response(body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

  logEvent("hlsEdge.originFetch", {
    channelId,
    rung,
    bytes: body.byteLength,
    durationMs: Date.now() - startTime,
  });

  const response = new Response(body, { status: 200, headers: new Headers(headers) });
  response.headers.set("X-HLS-Edge-Cache", "MISS");
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const preflight = handleCorsPreflight(env, request);
    if (preflight) {
      return preflight;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withCors(
        text(405, "Method not allowed"),
        env,
        request,
      );
    }

    const url = new URL(request.url);
    const match = PLAYLIST_PATH.exec(url.pathname);
    if (!match) {
      return withCors(json(404, { error: "Not found" }), env, request);
    }
    const channelId = match[1]!;
    const startedAt = match[2]!;
    const rung = match[3];

    const response = await handlePlaylistRequest(
      request,
      env,
      ctx,
      channelId,
      startedAt,
      rung,
    );
    return withCors(response, env, request);
  },
};

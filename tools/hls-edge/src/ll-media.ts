/**
 * LL media bytes through the Worker — task `L2.3`
 * (`docs/plans/LL_HLS.md` §7 "L2: the edge and the players").
 *
 * WHAT THIS ROUTE IS. `ll-playlist.js` renders every URI in an LL playlist
 * as `/api/voice/hls-playlist/:channelId/:startedAt/:rung/<name>?t=<token>`
 * — this Worker's own host, never the remux box's (`hls-remux.ts`'s
 * `llPlaylistUrl` doc comment: a raw origin URL is a bearer link nothing
 * can revoke short of ending the session). Until this module existed those
 * URIs 404'd, which is why `L2.2` shipped a playlist nothing could play.
 * This is the other half: the route that answers them, by fetching
 * `{LL_ORIGIN_BASE}/s/{sessionId}/{name}` with `X-Pqp-Origin-Key` and
 * handing the bytes back.
 *
 * WHY IT IS NOT THE CONVENTIONAL SEGMENT PATH. A conventional rung's
 * segments never touch this Worker at all: the API signs an R2 URL per
 * segment and the player fetches the bytes straight from storage
 * (`hls-playlist-proxy.ts`). The remux box has no such public, signable
 * surface — it is a private origin behind a shared key — so for LL the
 * Worker IS the CDN in front of it. That is also the whole point: an
 * immutable part cached per colo is what keeps the box serving ~13 Mbit/s
 * per session instead of one copy per viewer (`docs/plans/LL_HLS.md` §5,
 * "Bandwidth").
 *
 * THREE PROPERTIES THIS ROUTE OWES, and where each one lives:
 *
 *  1. **The token is checked before anything else happens** —
 *     `authorizeViewer` (`viewer-access.ts`), the same call the playlist
 *     routes make, including the revocation gate. A refused request never
 *     reaches `cache.match` and never reaches the box. The media URIs carry
 *     the viewer's own `?t=` because `index.ts`'s `stampLlToken` puts it
 *     there, per response, after the playlist cache — so the credential
 *     arrives on the media request the same way it does on the playlist
 *     request that named it.
 *  2. **The cache key is the path, never the token** (`edge-cache.ts`'s
 *     `cacheKeyRequest`, shared with the rendition route) — `part-164.m4s`
 *     is the same bytes for every viewer entitled to ask for it, so two
 *     viewers in one colo produce ONE origin fetch, which is this task's
 *     stated acceptance test. `Cache-Control: public, max-age=31536000,
 *     immutable` because a part, a segment and an init segment are written
 *     once and never rewritten: their names carry a sequence number, so a
 *     changed byte is always a new name.
 *  3. **A 404 stays a 404, and is never cached** — `EXT-X-PRELOAD-HINT`
 *     names a part the box has not finished writing, so a player asking for
 *     one slightly too early is NORMAL, not an error. Caching that 404 for
 *     a year would make the part permanently missing for every viewer in
 *     the colo. `no-store` on the way out, `hlsEdge.llPartMissing` on the
 *     way past.
 *
 * WHY THE BODY IS BUFFERED RATHER THAN STREAMED THROUGH. Coalescing is the
 * point of this route (property 2), and N coalesced callers need N
 * independent bodies — a `Response` body can be read once. The same
 * reasoning `index.ts`'s `fetchRenditionCoalesced` gives for returning a
 * buffered record. The sizes this is bounded to make that cheap: a part is
 * one part target of video (~200 KB at 3.2 Mbit/s and a 500 ms target) and
 * a sealed segment a few of them, nowhere near a Worker's memory bound.
 * Buffering inside `LlPlaylistOrigin.fetchMedia` also means one abort
 * window covers the whole exchange, which is what a box that sends headers
 * and then stalls needs (see `fetchFromOrigin`'s own doc comment).
 */

import { cacheKeyRequest, safeCacheMatch, safeCachePut } from "./edge-cache.js";
import { logEvent } from "./log.js";
import { playlistOriginKindForRung } from "./ll-state.js";
import { authorizeViewer, type ViewerAccessEnv } from "./viewer-access.js";
import type { PartyPassRevocationGate } from "./party-pass-revocation.js";

/** A year, in seconds — RFC 9111's practical ceiling and what `immutable` is paired with everywhere. */
const MEDIA_MAX_AGE_SECONDS = 31_536_000;
const MEDIA_CACHE_CONTROL = `public, max-age=${MEDIA_MAX_AGE_SECONDS}, immutable`;

/**
 * What `LlPlaylistOrigin` gives this route — deliberately narrower than the
 * class, so `test/ll-media.test.mjs` can hand it a fake with no remux box
 * and no `LL_ORIGIN_BASE` anywhere in sight.
 */
export interface LlMediaOrigin {
  readonly ready: boolean;
  fetchMedia(
    channelId: string,
    startedAt: string,
    name: string,
  ): Promise<{ status: number; ok: boolean; body: ArrayBuffer }>;
}

export interface LlMediaRoute {
  channelId: string;
  startedAt: string;
  rung: string;
  /** The media file name the playlist emitted: `init.mp4`, `seg-41.m4s`, `part-164.m4s`, or an `audio-` twin. */
  name: string;
}

/**
 * `.m4s` is a CMAF segment or part; `.mp4` is an initialization segment.
 * `video/iso.segment` is the registered type for the former (and what
 * Apple's own LL-HLS examples serve); `video/mp4` covers the latter and
 * anything unexpected. Players key on the playlist's own tags, not on this
 * header, so the practical job of getting it right is keeping proxies and
 * `mediastreamvalidator` happy rather than changing what plays.
 */
function contentTypeFor(name: string): string {
  return name.endsWith(".m4s") ? "video/iso.segment" : "video/mp4";
}

/**
 * Counters that would otherwise be one log line per viewer per part —
 * exactly the write amplifier pitfall 16 warns about — flushed as one
 * summary line per event per window instead. `hlsEdge.llPartOriginFetch` is
 * NOT in here on purpose: the cache and the in-flight map already bound it
 * to roughly one line per part per colo, and it is the line that proves
 * this task's acceptance test (one origin fetch for two viewers), so it is
 * logged directly, one for one.
 */
const COUNTER_FLUSH_INTERVAL_MS = 10_000;
interface CounterWindow {
  count: number;
  since: number;
  sampleChannelId: string;
  sampleRung: string;
  sampleName: string;
}
const counters = new Map<string, CounterWindow>();

function countEvent(event: string, route: LlMediaRoute): void {
  const now = Date.now();
  const window = counters.get(event);
  if (!window) {
    // THE FIRST ONE IS LOGGED IMMEDIATELY, not held until a window closes:
    // a rare event (one `llPartMissing` in a quiet hour) that only ever
    // surfaced once a SECOND one arrived would be invisible exactly when
    // somebody is reading the log to find out whether it happens at all.
    // Everything after it in the window is batched, which is what keeps a
    // party's worth of cache hits from becoming a party's worth of lines.
    logEvent(event, {
      count: 1,
      windowMs: 0,
      sampleChannelId: route.channelId,
      sampleRung: route.rung,
      sampleName: route.name,
    });
    counters.set(event, {
      count: 0,
      since: now,
      sampleChannelId: route.channelId,
      sampleRung: route.rung,
      sampleName: route.name,
    });
    return;
  }
  window.count += 1;
  window.sampleChannelId = route.channelId;
  window.sampleRung = route.rung;
  window.sampleName = route.name;
  if (now - window.since >= COUNTER_FLUSH_INTERVAL_MS) {
    logEvent(event, {
      count: window.count,
      windowMs: now - window.since,
      // Last one only — these are load counters, not a per-key breakdown,
      // and a per-key map would be the same amplifier problem one level
      // down (`index.ts`'s `noteCacheHit` makes the same choice).
      sampleChannelId: window.sampleChannelId,
      sampleRung: window.sampleRung,
      sampleName: window.sampleName,
    });
    counters.delete(event);
  }
}

interface FetchedMedia {
  status: number;
  ok: boolean;
  body: ArrayBuffer;
}

interface CoalescedMedia {
  result: FetchedMedia;
  /** True for exactly the caller whose call started the origin fetch — only it writes the cache. */
  isProducer: boolean;
}

/**
 * One media object's origin fetch, shared by every concurrent caller asking
 * for the SAME cache key — the same in-flight-map pattern
 * `index.ts`'s `fetchRenditionCoalesced` uses for a rendition playlist, and
 * for the same reason: when a popular part is first asked for, every viewer
 * in the colo asks within the same few milliseconds and each of them
 * observes `cache.match` as empty. Keyed on the cache key (the path, never
 * the token), so viewers with different tokens share one fetch.
 *
 * This composes with, rather than replaces, `LlPlaylistOrigin`'s own
 * per-path in-flight map: that one de-duplicates across every caller inside
 * the origin class (a `state.json` probe and a part fetch alike), this one
 * additionally decides WHO writes the cache, which the origin has no way to
 * know.
 */
const inFlightMediaFetches = new Map<string, Promise<FetchedMedia>>();

async function fetchMediaCoalesced(
  cacheKeyUrl: string,
  origin: LlMediaOrigin,
  route: LlMediaRoute,
): Promise<CoalescedMedia> {
  const existing = inFlightMediaFetches.get(cacheKeyUrl);
  if (existing) {
    return { result: await existing, isProducer: false };
  }
  const startTime = Date.now();
  const promise = (async (): Promise<FetchedMedia> => {
    let fetched: FetchedMedia;
    try {
      fetched = await origin.fetchMedia(route.channelId, route.startedAt, route.name);
    } catch (error) {
      // Logged HERE, once, however many callers share this fetch -- the
      // same rule `fetchRenditionCoalesced` documents.
      logEvent("hlsEdge.llPartOriginError", {
        channelId: route.channelId,
        rung: route.rung,
        name: route.name,
        error: String(error),
      });
      throw new Error("ll media fetch failed");
    }
    if (fetched.ok) {
      logEvent("hlsEdge.llPartOriginFetch", {
        channelId: route.channelId,
        rung: route.rung,
        name: route.name,
        bytes: fetched.body.byteLength,
        durationMs: Date.now() - startTime,
      });
    }
    return fetched;
  })();
  inFlightMediaFetches.set(cacheKeyUrl, promise);
  try {
    return { result: await promise, isProducer: true };
  } finally {
    inFlightMediaFetches.delete(cacheKeyUrl);
  }
}

function text(status: number, body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...extraHeaders },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * The LL media route. Exported for `index.ts` (which supplies
 * `caches.default`) and for `test/ll-media.test.mjs` (which supplies a fake
 * `Cache`) — the injected cache is the seam that lets this whole route run
 * under `node --test` with no Workers runtime, unlike the rendition route,
 * which reaches `caches.default` directly.
 */
export async function handleLlMediaRequest(
  request: Request,
  origin: LlMediaOrigin,
  cache: Cache,
  ctx: ExecutionContext,
  env: ViewerAccessEnv,
  gate: PartyPassRevocationGate,
  route: LlMediaRoute,
): Promise<Response> {
  // Only the LL rungs have media on this Worker at all. A conventional
  // rung's segments are presigned storage URLs the player fetches straight
  // from R2 and never through here (see this file's header), so a
  // `/720p30/seg-1.m4s` shaped request is a request for something that has
  // never existed on this host -- 404, before any credential work, the same
  // answer an unmatched path gets.
  if (playlistOriginKindForRung(route.rung) !== "ll") {
    return json(404, { error: "Not found" });
  }

  const access = await authorizeViewer({
    url: new URL(request.url),
    env,
    gate,
    channelId: route.channelId,
    startedAt: route.startedAt,
    rung: route.rung,
    // A party pass authorizes media the same way it authorizes the
    // rendition playlist that named it -- refusing here would mean a
    // pass-holding viewer got a playable playlist whose every URI 403s.
    allowPartyPass: true,
    // Nothing downstream of this route ever reaches the API, so there is no
    // always-current origin check behind it -- this Worker's own gate is
    // the only one, exactly as it is for the LL master.
    checkTokenRevocation: true,
  });
  if (!access.ok) {
    return json(access.status, { error: "Unauthorized", reason: access.reason });
  }

  if (!origin.ready) {
    // `LL_ORIGIN_BASE` unset: no LL playlist was ever rendered, so nothing
    // legitimately points at this URL. Same 404 as an unknown rung rather
    // than a new failure shape.
    logEvent("hlsEdge.llMediaOriginNotConfigured", {
      channelId: route.channelId,
      rung: route.rung,
    });
    return json(404, { error: "Not found" });
  }

  const cacheKey = cacheKeyRequest(request);
  const cached = await safeCacheMatch(cache, cacheKey);
  if (cached) {
    countEvent("hlsEdge.llPartCacheHit", route);
    const headers = new Headers(cached.headers);
    headers.set("X-HLS-Edge-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  let fetched: FetchedMedia;
  let isProducer: boolean;
  try {
    const coalesced = await fetchMediaCoalesced(cacheKey.url, origin, route);
    fetched = coalesced.result;
    isProducer = coalesced.isProducer;
  } catch {
    // Already logged once, inside the shared fetch.
    return text(502, "Origin fetch failed", { "Cache-Control": "no-store" });
  }

  if (fetched.status === 404) {
    // The ordinary preload-hint race: the playlist named a part the box has
    // not finished writing. Passed through as a 404 the player retries,
    // NEVER cached -- see this file's header, property 3.
    countEvent("hlsEdge.llPartMissing", route);
    return text(404, "Not found", { "Cache-Control": "no-store" });
  }

  if (!fetched.ok) {
    logEvent("hlsEdge.llPartOriginRejected", {
      channelId: route.channelId,
      rung: route.rung,
      name: route.name,
      status: fetched.status,
    });
    return text(502, "Origin fetch failed", { "Cache-Control": "no-store" });
  }

  const headers = new Headers({
    "Content-Type": contentTypeFor(route.name),
    "Cache-Control": MEDIA_CACHE_CONTROL,
    "Content-Length": String(fetched.body.byteLength),
  });

  // ONLY THE PRODUCER WRITES THE CACHE -- every other caller sharing this
  // fetch already holds the same bytes, and a duplicate `cache.put` per
  // waiter is pure waste (the same finding Farol raised against the
  // rendition route).
  if (isProducer) {
    const toCache = new Response(fetched.body, { status: 200, headers: new Headers(headers) });
    ctx.waitUntil(safeCachePut(cache, cacheKey, toCache));
  }

  const response = new Response(fetched.body, { status: 200, headers });
  response.headers.set("X-HLS-Edge-Cache", "MISS");
  return response;
}

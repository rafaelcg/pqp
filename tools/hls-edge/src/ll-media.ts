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
 * WHY THE BODY IS BUFFERED, AND WHY ONLY ONE REQUEST KEEPS THE BUFFER.
 * `LlPlaylistOrigin.fetchMedia` reads the whole object inside one abort
 * window, which is what a box that sends headers and then stalls needs (see
 * `fetchFromOrigin`'s own doc comment) — so the producer holds it in isolate
 * memory either way. What must NOT happen is every coalesced waiter building
 * its own `Response` from that same buffer and holding a copy until its own
 * client drains: hundreds of viewers times a several-hundred-KB segment is
 * real pressure on one isolate. So a waiter awaits the producer's cache
 * write (already in flight, a few ms, against an origin fetch it has already
 * paid for) and reads the entry back out of the cache, streaming from the
 * colo rather than from the isolate. The shared buffer is its fallback only
 * if that read comes back empty.
 *
 * AND WHY NEITHER OF THOSE AWAITS MAY BE UNBOUNDED (production,
 * 2026-09-15, the evening after PR #645). Both of the paragraph above's
 * `await`s -- the joiner's share of the origin fetch, and the joiner's wait
 * on the producer's cache write -- were on promises created in ANOTHER
 * REQUEST'S context, and in Workers that is the one thing a request may
 * never bet its response on:
 *
 *   **A `fetch()` and a `setTimeout()` belong to the request context that
 *   created them.** When that request is answered or aborted, its pending
 *   I/O is cancelled, its timers stop firing, and a second request parked on
 *   its promise never resumes.
 *
 * `coalesced-fetch.js`'s header has the full derivation; PR #645 applied it
 * to the PLAYLIST path and left this one alone, on the reading that
 * `ctx.waitUntil` below already anchored the producer. It anchors the
 * producer. It does nothing for the joiner. Two players on one LL session
 * (a viewer and the host's own "Publico" preview) ask for the same part
 * within ~15 ms all evening -- one produces, one joins -- and hls.js cancels
 * a part request the instant it decides to stall, which takes the producer's
 * context with it. Five media requests that evening were killed with "your
 * Worker's code had hung and would never generate a response", each after a
 * WALL TIME OF 5-6 ms: `ll/part-941.m4s`, `ll/part-1004.m4s`,
 * `ll-audio/audio-part-1020.m4s`, `ll-audio/audio-part-1030.m4s`,
 * `ll-audio/audio-part-1475.m4s` -- against an origin that answered 3,093
 * requests in the same window with two legitimate 404s and a max of 691 ms.
 * The wall time IS the diagnosis, the same way it was in #645: those
 * requests were never waiting on anything real, because everything they were
 * waiting on belonged to somebody else.
 *
 * FOUR LAYERS, none of which has to be right on its own:
 *
 *  1. `coalesceFetch` (`coalesced-fetch.js`) replaces the hand-rolled
 *     in-flight map. A joiner's share is bounded by a timer OF ITS OWN and
 *     is detachable; the producer is anchored with `ctx.waitUntil`; and the
 *     producer is elected per key at SETTLEMENT, so a fetch that was
 *     detached from and replaced does not write the cache under its own
 *     replacement when it lands late.
 *  2. The joiner's wait on the cache write is bounded the same way
 *     (`awaitBounded`, `DEFAULT_MEDIA_WRITE_JOIN_BOUND_MS`), and a write
 *     promise that misses its bound is DROPPED from the map, so the next
 *     arrival does not queue behind the same dead context too.
 *  3. The write is published from INSIDE the shared chain, the instant the
 *     origin answers, rather than from the producing request's continuation.
 *     That keeps the window Farol caught on `L2.3`'s first commit closed --
 *     an arrival always sees either the in-flight fetch or the in-flight
 *     write, never an empty cache and an empty map -- which `coalesceFetch`
 *     deleting its map entry at settlement would otherwise have reopened.
 *  4. A last-resort `Promise.race` over the whole served path
 *     (`DEFAULT_MEDIA_HARD_TIMEOUT_MS`), armed with a timer in THIS
 *     request's context. It is what makes the hang detector structurally
 *     unreachable -- the request always holds live pending I/O of its own --
 *     and when it fires, the request answers itself by fetching the part
 *     directly. `hlsEdge.llMediaHardTimeout` belongs at zero, and so does
 *     `hlsEdge.llMediaJoinDetached`.
 */

import { cacheKeyRequest, safeCacheMatch, safeCachePut } from "./edge-cache.js";
import { coalesceFetch } from "./coalesced-fetch.js";
import { logEvent } from "./log.js";
import { LL_AUDIO_RUNG, playlistOriginKindForRung } from "./ll-state.js";
import { authorizeViewer, type ViewerAccessEnv } from "./viewer-access.js";
import type { PartyPassRevocationGate } from "./party-pass-revocation.js";

/**
 * THE NAMES THIS ROUTE WILL ASK THE BOX FOR — narrower than
 * `isSafeUriSegment`, deliberately.
 *
 * `isSafeUriSegment` (`ll-state.js`) answers "can this string be a path
 * segment without escaping", which is the right question for a document the
 * remux wrote. It is the WRONG question for a name a VIEWER supplies: a
 * party viewer holding a perfectly valid token could ask for `probe-1`,
 * `probe-2`, ... forever, and since a name the box does not have 404s and a
 * 404 is deliberately never cached (property 3), every one of those would be
 * another real fetch against the origin — a viewer-driven amplifier against
 * the one box serving the party. Farol caught it on this PR's first commit.
 *
 * So the route accepts only the filename grammar `pqp-remuxd` actually
 * writes (`internal/serve`, and `ll-state.js`'s own contract): an init
 * segment, a sealed segment, or a part, each with an optional `audio-`
 * prefix that must AGREE with the rung being asked for — the video rung can
 * never fetch the audio ring's files and vice versa. Anything else is
 * refused here, with no origin fetch at all.
 *
 * IF A PRODUCER EVER CHANGES ITS NAMING, THIS IS THE ONE PLACE TO WIDEN.
 * `state.json`'s contract permits any safe name, so a future remux could
 * legitimately name things differently; `test/ll-state-remux-golden.test.mjs`
 * pins the names the real one emits today, and `hlsEdge.llPartNameRefused`
 * is what a divergence would look like from the outside.
 *
 * `init(?:-\d+)?\.mp4` covers the first generation (`init.mp4`) and every
 * later one published after an H.264 parameter-set change (`init-2.mp4`,
 * …) — same grammar `pqp-remux`'s `isVideoInitURI` accepts. Without the
 * numbered form, a playlist that correctly advertised `init-2.mp4` after
 * a resolution ramp would 404 every MAP fetch and leave viewers with no
 * video again (PR #656 review).
 */
const MEDIA_NAME_PATTERN = /^(init(?:-\d{1,12})?\.mp4|seg-\d{1,12}\.m4s|part-\d{1,12}\.m4s)$/;
const AUDIO_NAME_PREFIX = "audio-";

function nameBelongsToRung(name: string, rung: string): boolean {
  const isAudioRung = rung === LL_AUDIO_RUNG;
  const isAudioName = name.startsWith(AUDIO_NAME_PREFIX);
  if (isAudioRung !== isAudioName) {
    return false;
  }
  return MEDIA_NAME_PATTERN.test(isAudioName ? name.slice(AUDIO_NAME_PREFIX.length) : name);
}

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
  /**
   * Which route is being served. Absent means an LL part (everything this
   * module did before `segment-media.ts` shared its serving path); a
   * conventional segment's events are logged under `hlsEdge.segment*` so the
   * two never blur into one counter.
   */
  kind?: "ll" | "segment";
}

/**
 * The event name for `route`: the LL name as written, or its `hlsEdge.segment*`
 * twin for a conventional segment (`hlsEdge.llPartCacheHit` ->
 * `hlsEdge.segmentCacheHit`, `hlsEdge.llMediaHardTimeout` ->
 * `hlsEdge.segmentHardTimeout`).
 */
function mediaEvent(route: LlMediaRoute, llName: string): string {
  return route.kind === "segment"
    ? llName.replace(/^hlsEdge\.ll(?:Part|Media)/, "hlsEdge.segment")
    : llName;
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
  if (name.endsWith(".ts")) {
    return "video/mp2t";
  }
  if (name.endsWith(".aac")) {
    return "audio/aac";
  }
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
  /**
   * The producer's cache write, when one is in flight for this key.
   * Published from inside the shared chain the instant the origin answers
   * (`publishCacheWrite`), so every joiner and every late arrival finds it
   * deterministically rather than racing the producer's continuation.
   * A NON-producer awaits it -- BOUNDED, see `awaitBounded` -- and then
   * reads the entry back out of the cache instead of building its own
   * `Response` from the shared buffer. `null` when the fetch was not ok (a
   * 404 is never cached) or when the write has already finished.
   */
  settled: Promise<void> | null;
  /**
   * True only for the caller whose fetch was still this key's current one
   * when it settled -- `coalesceFetch`'s definition, not "my call started a
   * fetch". See that module's doc comment for why the difference matters.
   */
  isProducer: boolean;
}

/**
 * How long a joiner waits on the producer's CACHE WRITE before giving up on
 * it and answering from its own copy of the shared buffer.
 *
 * The write is a `cache.put` against the colo, single-digit milliseconds in
 * the ordinary case, and the producer has already paid for the bytes. So
 * reaching this bound does not mean the cache is slow: it means the context
 * that owned the write is gone, which is exactly the failure this whole
 * module was rewritten for. One second, the same value and the same
 * reasoning as `coalesced-fetch.js`'s `DEFAULT_JOIN_BOUND_MS`.
 */
export const DEFAULT_MEDIA_WRITE_JOIN_BOUND_MS = 1_000;

/**
 * The last-resort guard on the whole served path, and the reason the
 * Workers hang detector can no longer reach this route at all: a timer armed
 * in THIS request's context is live pending I/O, whatever every shared
 * promise above it is doing.
 *
 * Five seconds, chosen to sit comfortably ABOVE every deliberate bound
 * below it -- `MAX_JOIN_ATTEMPTS * DEFAULT_JOIN_BOUND_MS` (2 s) plus
 * `DEFAULT_MEDIA_WRITE_JOIN_BOUND_MS` (1 s) -- and comfortably BELOW the
 * point at which a part is worth waiting for at all: the part target is
 * 500 ms, so a viewer still waiting at five seconds is ten parts behind and
 * has already stalled. It is deliberately under `UPSTREAM_TIMEOUT_MS` (8 s,
 * `index.ts`), which means a genuinely slow-but-alive origin fetch loses
 * this race and costs one extra fetch. That is the trade this guard exists
 * to make: a request that is never answered is worse than one more request
 * against a box whose measured max is 691 ms. `hlsEdge.llMediaHardTimeout`
 * is how you find out it happened, and it belongs at zero.
 */
export const DEFAULT_MEDIA_HARD_TIMEOUT_MS = 5_000;

/**
 * The timers this route arms, injectable so `test/ll-media.test.mjs` can
 * make a bound fire deterministically instead of sleeping for a second.
 * Every one of them is armed with `setTimer` IN THE CALLING REQUEST'S
 * CONTEXT -- that is the entire point (see this file's header), so a fake
 * that never fires would be testing the opposite of the fix.
 */
export interface LlMediaTimers {
  setTimer?: (ms: number, cb: () => void) => () => void;
  /** Passed straight to `coalesceFetch`; defaults to `DEFAULT_JOIN_BOUND_MS`. */
  joinBoundMs?: number;
  /** How long a preload-hinted LL part is held before a 404; `DEFAULT_PRELOAD_HOLD_MS`. 0 turns the hold off. */
  preloadHoldMs?: number;
  /** How often a held request looks again; `PRELOAD_POLL_MS`. */
  preloadPollMs?: number;
  writeJoinBoundMs?: number;
  hardTimeoutMs?: number;
}

/** @returns a cancel function, so a guard that lost its race stops holding the context open. */
function defaultSetTimer(ms: number, cb: () => void): () => void {
  const handle = setTimeout(cb, ms);
  return () => clearTimeout(handle);
}

/**
 * Awaits `promise`, but never for longer than `boundMs`, with the timer
 * armed in THIS request's context -- and never leaving an unhandled
 * rejection behind when the bound wins first.
 *
 * Resolves `true` when the promise settled (either way: a rejected write is
 * finished business, and reading the cache is still the right next move),
 * `false` when the bound won.
 */
function awaitBounded(
  promise: Promise<unknown>,
  boundMs: number,
  setTimer: (ms: number, cb: () => void) => () => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const cancel = setTimer(boundMs, () => {
      if (done) {
        return;
      }
      done = true;
      resolve(false);
    });
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      cancel();
      resolve(true);
    };
    // Both handlers attached unconditionally, even after the bound has
    // already won: this is the only handler this caller ever gives the
    // shared promise, and dropping it on a timeout would turn a later
    // rejection into an unhandled one, which in Workers is an error the
    // runtime reports against the isolate. Same rule as `joinBounded`.
    promise.then(finish, finish);
  });
}

/**
 * One media object's origin fetch, shared by every concurrent caller asking
 * for the SAME cache key -- the same in-flight-map pattern `index.ts`'s
 * `fetchRenditionCoalesced` uses for a rendition playlist, and for the same
 * reason: when a popular part is first asked for, every viewer in the colo
 * asks within the same few milliseconds and each of them observes
 * `cache.match` as empty. Keyed on the cache key (the path, never the
 * token), so viewers with different tokens share one fetch.
 *
 * SHARED THROUGH `coalesceFetch`, NOT THROUGH A BARE MAP (2026-09-15) --
 * see this file's header for the five hung requests that bought that rule,
 * and `coalesced-fetch.js` for how a bounded, detachable join works.
 *
 * THE WRITE IS PUBLISHED BEFORE THE FETCH IS UNPUBLISHED. `coalesceFetch`
 * clears its map entry when the fetch SETTLES, which on its own would
 * reopen the window Farol caught on this route's first commit: a viewer
 * arriving between the origin answering and the cache being populated would
 * see an empty cache AND an empty in-flight map and start a second real
 * fetch, at exactly the moment the burst arrives. So `produce` publishes
 * the write into `settledMediaWrites` from INSIDE the shared chain, before
 * it resolves -- the two maps overlap, and an arrival always has something
 * to join.
 *
 * This composes with, rather than replaces, `LlPlaylistOrigin`'s own
 * per-path in-flight map: that one de-duplicates across every caller inside
 * the origin class (a `state.json` probe and a part fetch alike), this one
 * additionally owns the cache write, which the origin has no way to do.
 */
const inFlightMediaFetches = new Map<string, Promise<FetchedMedia>>();
const settledMediaWrites = new Map<string, Promise<void>>();

/**
 * ONLY THE FETCH THAT PRODUCED THE BYTES WRITES THEM, and it writes them
 * from inside the shared chain rather than from its own request handler --
 * every other caller sharing this fetch would otherwise run the identical
 * `cache.put` on the identical key for no benefit (the same finding Farol
 * raised against the rendition route).
 *
 * `ctx` here is the PRODUCING request's context, because `produce` is
 * called synchronously on that request's stack, so `ctx.waitUntil` anchors
 * the write to the one context that has a reason to outlive its response.
 */
function publishCacheWrite(
  key: string,
  cacheKey: Request,
  cache: Cache,
  route: LlMediaRoute,
  fetched: FetchedMedia,
  ctx: ExecutionContext,
): void {
  const toCache = new Response(fetched.body, {
    status: 200,
    headers: mediaHeaders(route, fetched.body.byteLength),
  });
  const write: Promise<void> = safeCachePut(cache, cacheKey, toCache).finally(() => {
    // Only if it is still ours: a later fetch for the same key may already
    // have published its own write, and evicting that one would send every
    // arrival straight to the origin.
    if (settledMediaWrites.get(key) === write) {
      settledMediaWrites.delete(key);
    }
  });
  settledMediaWrites.set(key, write);
  ctx.waitUntil(write);
}

async function fetchMediaCoalesced(
  cacheKey: Request,
  origin: LlMediaOrigin,
  route: LlMediaRoute,
  cache: Cache,
  ctx: ExecutionContext,
  timers: LlMediaTimers,
): Promise<CoalescedMedia> {
  const key = cacheKey.url;
  const produce = async (): Promise<FetchedMedia> => {
    const startTime = Date.now();
    let fetched: FetchedMedia;
    try {
      fetched = await origin.fetchMedia(route.channelId, route.startedAt, route.name);
    } catch (error) {
      // Logged HERE, once, however many callers share this fetch -- the
      // same rule `fetchRenditionCoalesced` documents.
      logEvent(mediaEvent(route, "hlsEdge.llPartOriginError"), {
        channelId: route.channelId,
        rung: route.rung,
        name: route.name,
        error: String(error),
      });
      throw new Error("ll media fetch failed");
    }
    if (fetched.ok) {
      logEvent(mediaEvent(route, "hlsEdge.llPartOriginFetch"), {
        channelId: route.channelId,
        rung: route.rung,
        name: route.name,
        bytes: fetched.body.byteLength,
        durationMs: Date.now() - startTime,
      });
      publishCacheWrite(key, cacheKey, cache, route, fetched, ctx);
    }
    return fetched;
  };

  // BOTH HALVES OF THE FIX (see `coalesced-fetch.js`'s header). `keepAlive`
  // extends the PRODUCING request's context past its own response, so the
  // fetch every joiner is sharing survives long enough to answer them. The
  // bounded, detachable join inside `coalesceFetch` is the other half, for
  // the joiners of a producer that dies anyway -- a viewer whose player
  // cancels a part request takes their context with it whatever this Worker
  // does, and on this route that is not an edge case: it is what hls.js
  // does every time it decides it has stalled.
  const coalesced = await coalesceFetch(inFlightMediaFetches, key, produce, {
    joinBoundMs: timers.joinBoundMs,
    setTimer: timers.setTimer ?? defaultSetTimer,
    keepAlive: (promise) => ctx.waitUntil(promise),
    onDetach: ({ reason, attempt }) => {
      logEvent(mediaEvent(route, "hlsEdge.llMediaJoinDetached"), {
        channelId: route.channelId,
        rung: route.rung,
        name: route.name,
        reason,
        attempt,
      });
    },
  });
  return {
    result: coalesced.result,
    isProducer: coalesced.isProducer,
    settled: settledMediaWrites.get(key) ?? null,
  };
}

function mediaHeaders(route: LlMediaRoute, byteLength: number): Headers {
  return new Headers({
    "Content-Type": contentTypeFor(route.name),
    "Cache-Control": MEDIA_CACHE_CONTROL,
    "Content-Length": String(byteLength),
  });
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
 * The two answers that are not bytes, shared by the coalesced path and the
 * hard-timeout path so they cannot drift apart.
 *
 * A 404 is the ordinary preload-hint race -- the playlist named a part the
 * box has not finished writing -- passed through as a 404 the player
 * retries and NEVER cached (this file's header, property 3).
 */
function refusalFor(fetched: FetchedMedia, route: LlMediaRoute, quiet404 = false): Response | null {
  if (fetched.status === 404) {
    if (!quiet404) {
      countEvent(mediaEvent(route, "hlsEdge.llPartMissing"), route);
    }
    return text(404, "Not found", { "Cache-Control": "no-store" });
  }
  if (!fetched.ok) {
    logEvent(mediaEvent(route, "hlsEdge.llPartOriginRejected"), {
      channelId: route.channelId,
      rung: route.rung,
      name: route.name,
      status: fetched.status,
    });
    return text(502, "Origin fetch failed", { "Cache-Control": "no-store" });
  }
  return null;
}

/**
 * Reads the entry the producer has just written (or is writing) and serves
 * it, streaming from the colo instead of from this isolate's copy of the
 * shared buffer -- see this file's header, "WHY THE BODY IS BUFFERED".
 * `null` when there is nothing there, which is always a fall-through to a
 * real fetch, never a failure.
 */
async function serveFromPendingWrite(
  pending: Promise<void> | null,
  key: string,
  cacheKey: Request,
  cache: Cache,
  route: LlMediaRoute,
  timers: LlMediaTimers,
): Promise<Response | null> {
  if (pending) {
    const settledInTime = await awaitBounded(
      pending,
      timers.writeJoinBoundMs ?? DEFAULT_MEDIA_WRITE_JOIN_BOUND_MS,
      timers.setTimer ?? defaultSetTimer,
    );
    if (!settledInTime) {
      // The context that owned the write is gone. Drop the entry so the
      // NEXT arrival does not spend its own bound queueing behind the same
      // corpse, then read the cache anyway -- the write may still have
      // landed before its owner went away.
      countEvent(mediaEvent(route, "hlsEdge.llMediaWriteJoinTimeout"), route);
      if (settledMediaWrites.get(key) === pending) {
        settledMediaWrites.delete(key);
      }
    }
  }
  const warmed = await safeCacheMatch(cache, cacheKey);
  if (!warmed) {
    return null;
  }
  const headers = new Headers(warmed.headers);
  headers.set("X-HLS-Edge-Cache", "COALESCED");
  return new Response(warmed.body, { status: warmed.status, headers });
}

/**
 * The ordinary served path: join whatever is already happening for this
 * key, or produce it. Never rejects -- every failure is a `Response` --
 * because it is one half of a `Promise.race` whose other half is a timer,
 * and a rejection racing a timer is an unhandled rejection waiting to
 * happen.
 */
async function serveCoalesced(
  cacheKey: Request,
  origin: LlMediaOrigin,
  route: LlMediaRoute,
  cache: Cache,
  ctx: ExecutionContext,
  timers: LlMediaTimers,
  quiet404 = false,
): Promise<Response> {
  const key = cacheKey.url;

  // A producer may already hold these bytes and be writing them. Joining
  // that write is cheaper than a second origin fetch, and it is what keeps
  // the gap between "the fetch settled" and "the cache is warm" from being
  // a hole in the collapse this route exists for.
  const pendingWrite = settledMediaWrites.get(key);
  if (pendingWrite) {
    const warm = await serveFromPendingWrite(pendingWrite, key, cacheKey, cache, route, timers);
    if (warm) {
      return warm;
    }
  }

  let coalesced: CoalescedMedia;
  try {
    coalesced = await fetchMediaCoalesced(cacheKey, origin, route, cache, ctx, timers);
  } catch {
    // Already logged once, inside the shared fetch.
    return text(502, "Origin fetch failed", { "Cache-Control": "no-store" });
  }

  const refusal = refusalFor(coalesced.result, route, quiet404);
  if (refusal) {
    return refusal;
  }

  // A WAITER IS SERVED FROM THE CACHE, NOT FROM THE SHARED BUFFER. The
  // producer holds the whole object in isolate memory (it has to: it just
  // read it), and every waiter that built its OWN `Response` from that same
  // buffer added another copy for as long as its client took to drain it --
  // hundreds of viewers times a several-hundred-KB segment is real memory
  // pressure on one isolate, which Farol flagged on this route's first
  // commit. The buffered copy below is the fallback for when that read
  // comes back empty -- a failed, evicted, or never-finished write --
  // because a viewer must never be worse off than before this optimization
  // existed.
  if (!coalesced.isProducer) {
    const warm = await serveFromPendingWrite(
      coalesced.settled,
      key,
      cacheKey,
      cache,
      route,
      timers,
    );
    if (warm) {
      return warm;
    }
  }

  const headers = mediaHeaders(route, coalesced.result.body.byteLength);
  headers.set("X-HLS-Edge-Cache", coalesced.isProducer ? "MISS" : "COALESCED");
  return new Response(coalesced.result.body, { status: 200, headers });
}

/**
 * The last resort, reached only when the guard timer beat every shared
 * promise this request was attached to: fetch the part for THIS request,
 * with this request's own context behind it, and answer. One extra origin
 * request, which is the cheap half of the trade described on
 * `DEFAULT_MEDIA_HARD_TIMEOUT_MS`.
 */
async function serveDirect(
  cacheKey: Request,
  origin: LlMediaOrigin,
  route: LlMediaRoute,
  cache: Cache,
  ctx: ExecutionContext,
): Promise<Response> {
  let fetched: FetchedMedia;
  try {
    fetched = await origin.fetchMedia(route.channelId, route.startedAt, route.name);
  } catch (error) {
    logEvent(mediaEvent(route, "hlsEdge.llPartOriginError"), {
      channelId: route.channelId,
      rung: route.rung,
      name: route.name,
      error: String(error),
    });
    return text(502, "Origin fetch failed", { "Cache-Control": "no-store" });
  }
  const refusal = refusalFor(fetched, route);
  if (refusal) {
    return refusal;
  }
  // Worth writing: whatever went wrong upstream, the colo not having these
  // bytes is why the next viewer would go through the same thing.
  const toCache = new Response(fetched.body, {
    status: 200,
    headers: mediaHeaders(route, fetched.body.byteLength),
  });
  ctx.waitUntil(safeCachePut(cache, cacheKey, toCache));
  const headers = mediaHeaders(route, fetched.body.byteLength);
  headers.set("X-HLS-Edge-Cache", "HARD-TIMEOUT");
  return new Response(fetched.body, { status: 200, headers });
}

/** The sentinel `Promise.race` returns when the guard timer wins. Never a `Response`, so the check cannot be accidentally truthy. */
const HARD_TIMEOUT = Symbol("ll-media-hard-timeout");

/**
 * PRELOAD HINTS ARE HELD, NOT REFUSED (RFC 8216bis 6.2.6).
 *
 * Every LL rendition playlist ends with `#EXT-X-PRELOAD-HINT:TYPE=PART` naming
 * the part the remux is still writing. hls.js never fetches a hint; AVPlayer,
 * Safari and Media3 do, the moment they read the playlist, and the protocol's
 * answer to "that part does not exist yet" is to hold the request open until
 * it does. This route used to answer 404 straight away: 59,878 video and
 * 70,421 audio 404s on the 2026-09-21 party, every one of them for part N+1,
 * and every one a native player that then had to come back for the same part.
 *
 * So a 404 for an LL PART that is newer than any this isolate has served for
 * that rendition is retried every `PRELOAD_POLL_MS` for up to
 * `DEFAULT_PRELOAD_HOLD_MS`, through the same coalesced fetch every other
 * viewer of the part shares, and answered the moment it lands. Bounded well
 * inside the 5 s hard timeout. A part at or below the high-water mark is one
 * that has left the remux's ring (a player recovering at a stale position),
 * and still gets its 404 immediately: holding it would only delay the
 * player's recovery. A part far past the mark is not a hint either. Segments,
 * init segments and conventional `.ts` are never held.
 */
export const DEFAULT_PRELOAD_HOLD_MS = 2_500;
export const PRELOAD_POLL_MS = 150;
/** A hint is part N+1; a little slack for a reload that raced a part boundary. */
const PRELOAD_MAX_AHEAD = 4;
const PART_NAME = /^(audio-)?part-(\d{1,12})\.m4s$/;
const HIGH_WATER_MAX = 256;
const partHighWater = new Map<string, number>();

function partOf(route: LlMediaRoute): { key: string; n: number } | null {
  if (route.kind === "segment") {
    return null;
  }
  const match = PART_NAME.exec(route.name);
  if (!match) {
    return null;
  }
  return {
    key: `${route.channelId}/${route.startedAt}/${match[1] ? "a" : "v"}`,
    n: Number(match[2]),
  };
}

function notePartServed(route: LlMediaRoute): void {
  const part = partOf(route);
  if (!part) {
    return;
  }
  const seen = partHighWater.get(part.key);
  if (seen === undefined || part.n > seen) {
    // Re-inserted so the Map's insertion order is recency, for the trim below.
    partHighWater.delete(part.key);
    partHighWater.set(part.key, part.n);
    if (partHighWater.size > HIGH_WATER_MAX) {
      const oldest = partHighWater.keys().next().value;
      if (oldest !== undefined) {
        partHighWater.delete(oldest);
      }
    }
  }
}

function isPreloadHint(route: LlMediaRoute): boolean {
  const part = partOf(route);
  if (!part) {
    return false;
  }
  const seen = partHighWater.get(part.key);
  return seen === undefined || (part.n > seen && part.n <= seen + PRELOAD_MAX_AHEAD);
}

/** For tests. */
export function resetPreloadHoldForTests(): void {
  partHighWater.clear();
}

async function serveHoldingPreloadHint(
  cacheKey: Request,
  origin: LlMediaOrigin,
  route: LlMediaRoute,
  cache: Cache,
  ctx: ExecutionContext,
  timers: LlMediaTimers,
): Promise<Response> {
  const holdMs = timers.preloadHoldMs ?? DEFAULT_PRELOAD_HOLD_MS;
  const hold = holdMs > 0 && isPreloadHint(route);
  let response = await serveCoalesced(cacheKey, origin, route, cache, ctx, timers, hold);
  if (response.status === 200) {
    notePartServed(route);
    return response;
  }
  if (!hold || response.status !== 404) {
    return response;
  }
  const setTimer = timers.setTimer ?? defaultSetTimer;
  const pollMs = timers.preloadPollMs ?? PRELOAD_POLL_MS;
  const started = Date.now();
  const deadline = started + holdMs;
  while (Date.now() + pollMs <= deadline) {
    await new Promise<void>((resolve) => {
      setTimer(pollMs, resolve);
    });
    response = await serveCoalesced(cacheKey, origin, route, cache, ctx, timers, true);
    if (response.status !== 404) {
      if (response.status === 200) {
        notePartServed(route);
      }
      countEvent(mediaEvent(route, "hlsEdge.llPartHeldServed"), route);
      return response;
    }
  }
  // The hold ran out: the 404 the player would have had straight away,
  // counted once as the miss it is.
  countEvent(mediaEvent(route, "hlsEdge.llPartHoldExpired"), route);
  countEvent(mediaEvent(route, "hlsEdge.llPartMissing"), route);
  return response;
}

/**
 * The LL media route. Exported for `index.ts` (which supplies
 * `caches.default`) and for `test/ll-media.test.mjs` (which supplies a fake
 * `Cache`) -- the injected cache is the seam that lets this whole route run
 * under `node --test` with no Workers runtime, unlike the rendition route,
 * which reaches `caches.default` directly. `timers` is the second such
 * seam, added with the 2026-09-15 fix: a test can make a join bound or the
 * hard timeout fire on demand instead of waiting a real second for it.
 */
export async function handleLlMediaRequest(
  request: Request,
  origin: LlMediaOrigin,
  cache: Cache,
  ctx: ExecutionContext,
  env: ViewerAccessEnv,
  gate: PartyPassRevocationGate,
  route: LlMediaRoute,
  timers: LlMediaTimers = {},
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

  // The name must be one the remux actually writes -- see
  // `MEDIA_NAME_PATTERN` for why a viewer-supplied name gets a narrower
  // check than a state.json-supplied one. Before the credential work, like
  // the rung check above: this is "that file does not exist here", not
  // "you may not have it".
  if (!nameBelongsToRung(route.name, route.rung)) {
    countEvent(mediaEvent(route, "hlsEdge.llPartNameRefused"), route);
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
    logEvent(mediaEvent(route, "hlsEdge.llMediaOriginNotConfigured"), {
      channelId: route.channelId,
      rung: route.rung,
    });
    return json(404, { error: "Not found" });
  }

  return serveImmutableMedia(request, origin, cache, ctx, route, timers);
}

/**
 * The part of this route that does not care what the bytes are: the colo
 * cache, the one-fetch-per-key coalescing, the bounded joins and the hard
 * timeout, for any object that is written once under a name that never
 * changes. Shared with `segment-media.ts` (conventional segments out of R2),
 * which runs its own credential check first and hands its route in with
 * `kind: "segment"`. CALLERS MUST HAVE AUTHORIZED THE REQUEST ALREADY: this
 * function serves whatever the cache or the origin has under the path.
 */
export async function serveImmutableMedia(
  request: Request,
  origin: LlMediaOrigin,
  cache: Cache,
  ctx: ExecutionContext,
  route: LlMediaRoute,
  timers: LlMediaTimers = {},
): Promise<Response> {
  const cacheKey = cacheKeyRequest(request);
  const cached = await safeCacheMatch(cache, cacheKey);
  if (cached) {
    notePartServed(route);
    countEvent(mediaEvent(route, "hlsEdge.llPartCacheHit"), route);
    const headers = new Headers(cached.headers);
    headers.set("X-HLS-Edge-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  // THE LAST-RESORT GUARD, and the reason the Workers hang detector can no
  // longer reach this route: from here down this request holds a timer of
  // its OWN, so it always has live pending I/O no matter what any shared
  // promise above it is doing. See this file's header, layer 4.
  const setTimer = timers.setTimer ?? defaultSetTimer;
  const hardTimeoutMs = timers.hardTimeoutMs ?? DEFAULT_MEDIA_HARD_TIMEOUT_MS;
  let cancelGuard: () => void = () => {};
  const guard = new Promise<typeof HARD_TIMEOUT>((resolve) => {
    cancelGuard = setTimer(hardTimeoutMs, () => resolve(HARD_TIMEOUT));
  });
  let served: Response | typeof HARD_TIMEOUT;
  try {
    served = await Promise.race([
      serveHoldingPreloadHint(cacheKey, origin, route, cache, ctx, timers),
      guard,
    ]);
  } finally {
    // Whoever won, the timer stops holding this context open.
    cancelGuard();
  }
  if (served !== HARD_TIMEOUT) {
    return served;
  }
  logEvent(mediaEvent(route, "hlsEdge.llMediaHardTimeout"), {
    channelId: route.channelId,
    rung: route.rung,
    name: route.name,
    budgetMs: hardTimeoutMs,
  });
  return serveDirect(cacheKey, origin, route, cache, ctx);
}

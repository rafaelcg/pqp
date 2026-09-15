/**
 * `PlaylistOrigin` for an LL session — the ONLY module in this Worker that
 * talks to the remux box directly, at `LL_ORIGIN_BASE`, never through the
 * API. `docs/plans/LL_HLS.md` task `L2.2`.
 *
 * WHY THIS TALKS TO THE ORIGIN DIRECTLY, UNLIKE `ApiPlaylistOrigin`. The
 * conventional path forwards a viewer's request to the API because the API
 * is what renders that playlist (`buildSignedPlaylist`). Nothing renders
 * the LL playlist ANYWHERE yet — `tools/pqp-remux/README.md`'s "Not yet"
 * section says so outright ("that is entirely the edge Worker's job in
 * `L2.1` and `L2.2`") — so this Worker has to be the renderer, and a
 * renderer needs the raw material (`ll-state.js`'s `state.json` contract),
 * not somebody else's already-finished playlist text. Going through the API
 * for that material would add a hop for no reason: the API has no better
 * claim to `state.json` than this Worker does, and `hls-remux.ts`'s own doc
 * comment on `llPlaylistUrl` explains why the origin's raw host must stay
 * server-side FROM A VIEWER'S PERSPECTIVE — this Worker is not a viewer, the
 * same way it already isn't when it fetches from `ApiPlaylistOrigin`.
 *
 * FAILS TOWARD "FALL BACK TO CONVENTIONAL", NEVER TOWARD "BREAK THE MASTER
 * ROUTE". `fetchMultivariantPlaylist` is the one method whose caller
 * (`index.ts`) treats every failure — no LL session, a bad `state.json`, a
 * dead origin, an init segment this file's codec reader can't parse — as
 * `null`, meaning "build the LL master some other time; forward to the API
 * like `docs/plans/LL_HLS.md` §4 says a conventional session always could."
 * A session this Worker cannot confidently render as LL must never come
 * back as a 502 where the API would have answered it as
 * conventional-with-no-LL-rung; see that call site's own comment for why.
 *
 * `fetchPlaylist` renders with `LL_TOKEN_PLACEHOLDER`, never a real token —
 * see `ll-playlist.js`'s header. This is what lets `index.ts` cache and
 * coalesce an LL rendition response exactly like a conventional one; a
 * Farol review of this PR's first draft caught that embedding the real
 * token here leaked one viewer's bearer credential into the shared
 * cache/coalescer's entry, readable by every other viewer who hit it warm.
 *
 * A CONVENTIONAL MASTER REQUEST MUST NOT PAY THE FULL UPSTREAM TIMEOUT.
 * `fetchMultivariantPlaylist` runs for EVERY session/master request once
 * `LL_ORIGIN_BASE` is configured, LL or not — a conventional session's is
 * the common case at party scale, and each one used to probe `state.json`
 * and simply wait out `timeoutMs` (the SAME bound the codec/rendition
 * fetches use, chosen for those, not for this) before falling back to the
 * API. A Farol review flagged this twice: as latency (every conventional
 * master request pays the probe) and as availability (an unhealthy LL
 * origin holds every one of them for the full timeout before the API is
 * even tried). `MASTER_PROBE_TIMEOUT_MS` bounds THIS caller's own patience
 * separately from `timeoutMs` — `state.json` is a small, frequently
 * rewritten file a healthy remux answers in well under a second, so a
 * master request that has not heard back by then almost certainly belongs
 * to a conventional session or an unhealthy origin either way, and the
 * honest move is to answer from the API now rather than make a viewer's
 * player wait on a guess. The underlying fetch is never aborted when the
 * probe deadline wins — it keeps running under its own `timeoutMs` in the
 * background, exactly as `fetchFromOrigin`'s in-flight de-dup already
 * shares it with any other concurrent caller, and whatever it eventually
 * decides is remembered in `sessionProbeCache` so the NEXT master request
 * for the SAME (channelId, startedAt) skips the wait entirely for
 * `SESSION_PROBE_CACHE_TTL_MS` — turning "every viewer's join pays a
 * probe" into "one prober per window pays it."
 */

import { AAC_LC_CODEC, extractAvc1VideoInfo } from "./ll-init-codecs.js";
import {
  buildLlMultivariantPlaylist,
  buildLlRenditionPlaylist,
} from "./ll-playlist.js";
import { deriveLlSessionId } from "./ll-session.js";
import {
  LL_AUDIO_RUNG,
  LL_VIDEO_RUNG,
  isSafeUriSegment,
  parseLlState,
  trackForRung,
  type LlSessionState,
} from "./ll-state.js";
import type { PlaylistFetch, PlaylistOrigin } from "./playlist-origin.js";
import { logEvent } from "./log.js";

/** Bound on the per-session video-codec cache — same shape as `index.ts`'s `rejectionLog`: a churn of many short LL sessions must not grow this forever. */
const VIDEO_CODEC_CACHE_MAX_ENTRIES = 200;

/** See this file's header, "A CONVENTIONAL MASTER REQUEST MUST NOT PAY THE FULL UPSTREAM TIMEOUT" — deliberately much shorter than the `timeoutMs` the underlying origin fetch still runs under. */
const MASTER_PROBE_TIMEOUT_MS = 1_500;

/** How long a (channelId, startedAt) recently found to have no LL session (or an unreachable/erroring origin) is treated that way without asking again — same header. Short enough that a session which starts conventional and later grows an LL state (or a recovering origin) is noticed again within one window. */
const SESSION_PROBE_CACHE_TTL_MS = 5_000;

/** Same bounded-map shape as `videoCodecCache` below — a churn of distinct (channelId, startedAt) pairs must not grow this forever. */
const SESSION_PROBE_CACHE_MAX_ENTRIES = 500;

/** Thrown internally by `raceProbe` when `MASTER_PROBE_TIMEOUT_MS` elapses before the underlying fetch settles — never thrown across this module's own public API. */
class MasterProbeTimeoutError extends Error {}

/**
 * Only the VIDEO half of a session's codec info is cached — it is read off
 * `avcC` in `init.mp4`, which cannot change for the session's lifetime once
 * written. The AUDIO codec is deliberately NOT part of this shape: see
 * `videoCodecFor`'s doc comment for why caching it too was a real bug.
 */
interface CachedVideoCodec {
  videoCodec: string;
  videoWidth: number;
  videoHeight: number;
}

function statePath(sessionId: string): string {
  return `/s/${sessionId}/state.json`;
}

function originAssetPath(sessionId: string, uri: string): string {
  return `/s/${sessionId}/${uri}`;
}

/** This Worker's own viewer-facing route root for one session — see `ll-playlist.js`'s header, "WHAT THE URIS POINT AT". */
function renditionBasePath(channelId: string, startedAt: string): string {
  return `/api/voice/hls-playlist/${encodeURIComponent(channelId)}/${startedAt}`;
}

/** One fully-buffered remux-origin response: status plus the whole body, read inside the SAME abort window `fetchFromOrigin` opened — see that method's doc comment for why. */
interface BufferedOriginResponse {
  status: number;
  ok: boolean;
  body: ArrayBuffer;
}

export class LlPlaylistOrigin implements PlaylistOrigin {
  private readonly originBase: string | undefined;
  /**
   * `LL_ORIGIN_KEY` — this Worker's credential for reaching `pqp-remuxd`'s
   * media routes (`/s/:id/*`), sent as `X-Pqp-Origin-Key` on every request
   * `fetchFromOriginUncoalesced` makes. Matches `pqp-remuxd`'s
   * `MEDIA_ORIGIN_KEY`/`OriginKeyHeader` contract (`internal/control/server.go`,
   * PR #584's Farol-review fix) — a static shared value the origin
   * constant-time-compares, not a per-request signature; a viewer's player
   * never sees or produces it, the same way it never sees `LL_ORIGIN_BASE`
   * itself. Unset (the default until an operator sets the Worker secret):
   * no header is sent, matching `pqp-remuxd` leaving `MEDIA_ORIGIN_KEY`
   * empty for a loopback-only `CONTROL_LISTEN` — both sides default to the
   * same "no key configured" posture. See README.md "LL playlist (L2.2)".
   */
  private readonly originKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly videoCodecCache = new Map<string, CachedVideoCodec>();

  /**
   * In-flight de-duplication, keyed by the exact path fetched (a
   * `state.json` path IS `${channelId}:${startedAt}`-unique because the
   * `sessionId` it is derived from already is) — collapses a join burst's
   * simultaneous `fetchState`/video-init calls into ONE real fetch, the
   * same shape `index.ts`'s own `fetchRenditionCoalesced` already uses for
   * rendition requests. This is de-duplication, not caching: an entry lives
   * only from the first caller's request to its settlement (`finally`
   * deletes it), so it composes with, and does not replace, the durable
   * `videoCodecCache` above. NOT used for `state.json` itself past this
   * de-dup window, on purpose — a session's state changes every part
   * (~500ms), so caching it beyond "however many viewers asked in the same
   * instant" would serve stale segments/parts, unlike the codec string.
   */
  private readonly inFlight = new Map<string, Promise<BufferedOriginResponse>>();

  /**
   * `(channelId, startedAt)` key -> the epoch ms a "no LL session here" (or
   * "origin errored") result was last observed. Checked ONLY by
   * `fetchMultivariantPlaylist` — see this file's header, "A CONVENTIONAL
   * MASTER REQUEST MUST NOT PAY THE FULL UPSTREAM TIMEOUT". Never consulted
   * by `fetchPlaylist` (the rendition route): a viewer only ever asks for
   * `ll`/`ll-audio` because a master response already handed them that rung
   * name, so that route has no "is this even LL" question to short-circuit.
   */
  private readonly sessionProbeCache = new Map<string, number>();

  // A plain constructor body, not TypeScript parameter-property shorthand:
  // this class is exercised directly by `test/ll-playlist-origin.test.mjs`
  // under Node's native type-stripping (`node --experimental-strip-types`),
  // which erases type annotations but cannot inject the
  // `this.field = field` assignments parameter properties require --
  // `tsc --noEmit` doesn't care either way, but the test runner does.
  constructor(originBase: string | undefined, timeoutMs: number, originKey?: string) {
    this.originBase = originBase;
    this.timeoutMs = timeoutMs;
    this.originKey = originKey;
  }

  get ready(): boolean {
    return Boolean(this.originBase);
  }

  /**
   * One bounded, de-duplicated, FULLY BUFFERED fetch against the remux
   * origin (`state.json` or an init segment) — never a viewer-facing route.
   *
   * BUFFERS THE BODY INSIDE THE SAME ABORT WINDOW. A first version of this
   * method returned as soon as `fetch()` resolved and cleared its timer in
   * a `finally` right there — which only bounds the time to receive
   * RESPONSE HEADERS. A Farol review caught that a remux which sends
   * headers and then stalls mid-body (a large `init.mp4`, or `state.json`
   * dribbling out) was then read with NO deadline at all by whichever
   * caller ran `response.json()`/`.arrayBuffer()` afterward, since the
   * timer had already been cleared. Reading the whole body here, before
   * `finally` runs, means one timeout covers the ENTIRE exchange — the same
   * fix `ApiPlaylistOrigin.fetchPlaylist` already applies, for the same
   * reason (see that method's own doc comment).
   */
  private fetchFromOrigin(path: string): Promise<BufferedOriginResponse> {
    const existing = this.inFlight.get(path);
    if (existing) {
      return existing;
    }
    const promise = this.fetchFromOriginUncoalesced(path);
    this.inFlight.set(path, promise);
    return promise.finally(() => {
      this.inFlight.delete(path);
    });
  }

  private async fetchFromOriginUncoalesced(path: string): Promise<BufferedOriginResponse> {
    if (!this.originBase) {
      // The caller is expected to check `ready` first, same contract as
      // `ApiPlaylistOrigin.fetchPlaylist` — reaching this is a bug in this
      // module's caller, not something a viewer's request can trigger.
      throw new Error("LlPlaylistOrigin used before `ready`");
    }
    const url = new URL(path, this.originBase).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // `X-Pqp-Origin-Key`, only when `LL_ORIGIN_KEY` is configured — see
    // `originKey`'s doc comment above. Never attached to anything a viewer
    // can reach: this fetch talks to `pqp-remuxd` directly, and the
    // response built from it (`fetchPlaylist`/`fetchMultivariantPlaylist`)
    // always constructs a FRESH `Response` with only a `Content-Type`
    // header, never forwarding this request's own headers outward — see
    // `test/ll-playlist-origin.test.mjs`'s "never forwarded to a viewer"
    // case, which pins that.
    const headers: HeadersInit | undefined = this.originKey ? { "X-Pqp-Origin-Key": this.originKey } : undefined;
    try {
      const response = await fetch(url, { signal: controller.signal, headers });
      const body = await response.arrayBuffer();
      return { status: response.status, ok: response.ok, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `sessionId` (recomputed, never looked up — `ll-session.js`) plus the
   * parsed `state.json`, or `null` when this specific (channelId, startedAt)
   * has no LL session at all (a plain 404 from the origin — the ordinary
   * "this party is conventional" case, not a failure). Concurrent callers
   * for the SAME session share one origin fetch via `fetchFromOrigin`'s
   * in-flight map — a join burst of viewers or master requests for one
   * party produces one `state.json` fetch, not one per caller.
   */
  private async fetchState(
    channelId: string,
    startedAt: string,
  ): Promise<{ sessionId: string; state: LlSessionState } | null> {
    const sessionId = await deriveLlSessionId(channelId, Number(startedAt));
    const fetched = await this.fetchFromOrigin(statePath(sessionId));
    if (fetched.status === 404) {
      return null;
    }
    if (!fetched.ok) {
      throw new Error(`state.json fetch failed: ${fetched.status}`);
    }
    const text = new TextDecoder().decode(fetched.body);
    const parsed = parseLlState(JSON.parse(text));
    if (!parsed) {
      throw new Error("state.json failed validation");
    }
    return { sessionId, state: parsed };
  }

  /**
   * ONE MEDIA OBJECT off the box — an init segment, a sealed segment, or a
   * part — for the route that answers the URIs this class's own playlists
   * emit (`ll-media.ts`, task `L2.3`). `sessionId` is recomputed, never
   * looked up, exactly as `fetchState` does it.
   *
   * `name` is re-checked against `isSafeUriSegment` even though
   * `playlist-route.ts` already bounded it to the same pattern: this method
   * is what turns a name into a path against the remux origin, and the rule
   * that a name can never escape `/s/:sessionId/` belongs next to the
   * `new URL(path, base)` call that would otherwise be the place it escapes
   * (see `isSafeUriSegment`'s own doc comment for what that looks like).
   * A caller that gets here with something else has a bug; a viewer cannot
   * reach it, because the route rejected the request first.
   *
   * Returns the buffered origin response as-is, 404 included: "this part is
   * not written yet" is an ordinary answer on this route, not a failure —
   * see `ll-media.ts`'s header, property 3.
   */
  async fetchMedia(channelId: string, startedAt: string, name: string): Promise<BufferedOriginResponse> {
    if (!isSafeUriSegment(name)) {
      throw new Error("LlPlaylistOrigin.fetchMedia called with an unsafe name");
    }
    const sessionId = await deriveLlSessionId(channelId, Number(startedAt));
    return this.fetchFromOrigin(originAssetPath(sessionId, name));
  }

  /**
   * `PlaylistOrigin.fetchPlaylist`: one rung's LL media playlist. Only ever
   * called by `index.ts` for `rung === LL_VIDEO_RUNG || LL_AUDIO_RUNG` — see
   * that file's origin-selection comment.
   *
   * Renders with `LL_TOKEN_PLACEHOLDER`, ignoring `req.token` entirely for
   * the BODY (kept on `PlaylistFetch` only because the interface is shared
   * with `ApiPlaylistOrigin`, which DOES need a real token to authorize
   * against the API) — see `ll-playlist.js`'s header for why the body must
   * stay token-free to be safely cached/coalesced by `index.ts`.
   * `index.ts`'s `stampLlToken` is what turns this response into a specific
   * viewer's playable one, applied AFTER caching/coalescing, never here.
   */
  async fetchPlaylist(req: PlaylistFetch): Promise<Response> {
    if (req.rung !== LL_VIDEO_RUNG && req.rung !== LL_AUDIO_RUNG) {
      throw new Error(`LlPlaylistOrigin.fetchPlaylist called with an unexpected rung: ${req.rung ?? "(none)"}`);
    }
    const found = await this.fetchState(req.channelId, req.startedAt);
    if (!found) {
      return new Response("Not found", { status: 404 });
    }
    const track = trackForRung(found.state, req.rung);
    if (!track) {
      // A real LL session that has not (yet, or ever, e.g. no stage audio)
      // enabled this specific track — 404 for THIS rung, which the
      // existing non-200 handling in `index.ts` already refuses to cache.
      return new Response("Not found", { status: 404 });
    }
    const basePath = renditionBasePath(req.channelId, req.startedAt);
    const text = buildLlRenditionPlaylist(found.state, track, req.rung, { basePath });
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" },
    });
  }

  /**
   * The multivariant playlist for the session/master route, or `null` when
   * this Worker should not answer with one at all (no LL session; origin
   * unreachable; a `state.json` or init segment this file can't make sense
   * of). See this file's header, "FAILS TOWARD...". Called directly, per
   * request, with the CALLER's own real token (this route is never cached —
   * see `ll-playlist.js`'s header and `index.ts`'s own comment on the
   * session/master route for why that has always been true, LL or not).
   */
  async fetchMultivariantPlaylist(
    channelId: string,
    startedAt: string,
    token: string,
  ): Promise<Response | null> {
    const probeKey = `${channelId}:${startedAt}`;
    if (this.recentlyProbedNegative(probeKey)) {
      return null;
    }
    // Started once, awaited with a SHORT deadline below -- but never
    // aborted when that deadline wins, so a slow-but-eventually-answering
    // origin still gets to populate `sessionProbeCache` for the benefit of
    // the NEXT master request, even though THIS one already fell back to
    // the API. See this file's header, "A CONVENTIONAL MASTER REQUEST MUST
    // NOT PAY THE FULL UPSTREAM TIMEOUT".
    const statePromise = this.fetchState(channelId, startedAt);
    statePromise.then(
      (result) => {
        if (!result) {
          this.rememberNegativeProbe(probeKey);
        }
      },
      () => {
        this.rememberNegativeProbe(probeKey);
      },
    );
    let found: { sessionId: string; state: LlSessionState } | null;
    try {
      found = await this.raceProbe(statePromise, MASTER_PROBE_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof MasterProbeTimeoutError) {
        logEvent("hlsEdge.llMasterProbeTimedOut", { channelId, timeoutMs: MASTER_PROBE_TIMEOUT_MS });
      } else {
        logEvent("hlsEdge.llStateFetchFailed", { channelId, error: String(error) });
      }
      return null;
    }
    if (!found) {
      return null;
    }
    try {
      const videoCodec = await this.videoCodecFor(found.sessionId, found.state);
      // Derived FRESH from the state THIS request just fetched, never
      // cached — see `videoCodecFor`'s doc comment for why caching this
      // half was a real bug (a session that starts video-only and grows
      // audio later would otherwise never see the audio group appear).
      const audioCodec = found.state.audio ? AAC_LC_CODEC : null;
      const basePath = renditionBasePath(channelId, startedAt);
      const text = buildLlMultivariantPlaylist(found.state, {
        basePath,
        token,
        videoCodec: videoCodec.videoCodec,
        videoWidth: videoCodec.videoWidth,
        videoHeight: videoCodec.videoHeight,
        audioCodec,
      });
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" },
      });
    } catch (error) {
      logEvent("hlsEdge.llMultivariantBuildFailed", {
        channelId,
        sessionId: found.sessionId,
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Only the VIDEO codec/geometry is memoized here, and only once
   * successfully read — `avcC` in `init.mp4` cannot change for a session's
   * lifetime, so every later master request for the same session reuses it
   * with no origin fetch at all.
   *
   * A first version of this method cached the AUDIO codec alongside the
   * video one, computed from whatever `state.audio` happened to be on the
   * FIRST request that populated the cache. `state.json`'s own contract
   * (`ll-state.js`) says audio is legitimately absent until a stage source
   * has spoken — so a session observed video-only on its very first master
   * request cached `audioCodec: null` forever, and once a speaker DID join,
   * every later master request kept reading that stale cached `null` and
   * never grew an audio group for the rest of the Worker isolate's life. A
   * Farol review caught this. The fix is this method's scope: it now knows
   * nothing about audio at all, so there is nothing here left to go stale.
   *
   * Concurrent master requests for a session with no cached entry yet share
   * one video-init fetch via `fetchFromOrigin`'s in-flight de-duplication —
   * a join burst produces one `init.mp4` transfer, not one per viewer.
   */
  private async videoCodecFor(sessionId: string, state: LlSessionState): Promise<CachedVideoCodec> {
    const cached = this.videoCodecCache.get(sessionId);
    if (cached) {
      return cached;
    }
    const fetched = await this.fetchFromOrigin(originAssetPath(sessionId, state.video.initUri));
    if (!fetched.ok) {
      throw new Error(`video init fetch failed: ${fetched.status}`);
    }
    const videoInfo = extractAvc1VideoInfo(fetched.body);
    if (!videoInfo) {
      throw new Error("video init segment did not yield an avcC box");
    }
    const result: CachedVideoCodec = {
      videoCodec: videoInfo.codec,
      videoWidth: videoInfo.width,
      videoHeight: videoInfo.height,
    };
    if (this.videoCodecCache.size >= VIDEO_CODEC_CACHE_MAX_ENTRIES) {
      const oldestKey = this.videoCodecCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.videoCodecCache.delete(oldestKey);
      }
    }
    this.videoCodecCache.set(sessionId, result);
    return result;
  }

  /** True when `key` was last probed negative within `SESSION_PROBE_CACHE_TTL_MS` — see `sessionProbeCache`'s doc comment. */
  private recentlyProbedNegative(key: string): boolean {
    const at = this.sessionProbeCache.get(key);
    return at !== undefined && Date.now() - at < SESSION_PROBE_CACHE_TTL_MS;
  }

  private rememberNegativeProbe(key: string): void {
    if (this.sessionProbeCache.size >= SESSION_PROBE_CACHE_MAX_ENTRIES && !this.sessionProbeCache.has(key)) {
      const oldestKey = this.sessionProbeCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.sessionProbeCache.delete(oldestKey);
      }
    }
    this.sessionProbeCache.set(key, Date.now());
  }

  /**
   * Awaits `promise` but never for longer than `ms` — rejecting with
   * `MasterProbeTimeoutError` if the deadline wins, WITHOUT cancelling
   * `promise` itself (it keeps running under its own bound, e.g.
   * `fetchFromOrigin`'s `timeoutMs`, and whatever it eventually settles to
   * is still observed by any other `.then`/`await` already attached to it —
   * see the call site in `fetchMultivariantPlaylist`).
   */
  private raceProbe<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new MasterProbeTimeoutError()), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

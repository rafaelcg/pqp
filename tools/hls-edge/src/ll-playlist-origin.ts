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
  parseLlState,
  trackForRung,
  type LlSessionState,
} from "./ll-state.js";
import type { PlaylistFetch, PlaylistOrigin } from "./playlist-origin.js";
import { logEvent } from "./log.js";

/** Bound on the per-session video-codec cache — same shape as `index.ts`'s `rejectionLog`: a churn of many short LL sessions must not grow this forever. */
const VIDEO_CODEC_CACHE_MAX_ENTRIES = 200;

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

  // A plain constructor body, not TypeScript parameter-property shorthand:
  // this class is exercised directly by `test/ll-playlist-origin.test.mjs`
  // under Node's native type-stripping (`node --experimental-strip-types`),
  // which erases type annotations but cannot inject the
  // `this.field = field` assignments parameter properties require --
  // `tsc --noEmit` doesn't care either way, but the test runner does.
  constructor(originBase: string | undefined, timeoutMs: number) {
    this.originBase = originBase;
    this.timeoutMs = timeoutMs;
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
    try {
      const response = await fetch(url, { signal: controller.signal });
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
    let found: { sessionId: string; state: LlSessionState } | null;
    try {
      found = await this.fetchState(channelId, startedAt);
    } catch (error) {
      logEvent("hlsEdge.llStateFetchFailed", { channelId, error: String(error) });
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
}

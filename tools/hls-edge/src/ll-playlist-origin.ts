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
 * FAILS TOWARD "NOT READY YET", NEVER TOWARD "HERE IS THE OTHER LADDER".
 * `fetchMultivariantPlaylist` used to collapse every failure — no LL
 * session, a bad `state.json`, a dead origin, an unreadable init segment —
 * into `null`, which its caller read as "this party is conventional, forward
 * to the API". That conflated two different things, and the difference cost
 * four production attempts at low latency on 2026-09-15: a session 300 ms
 * old has no `state.json` yet AND IS LOW-LATENCY, and answering it with the
 * conventional master handed the audience a ladder that, for an LL session,
 * nothing is writing. It is not this module's job to decide the mode any
 * more — `requestsLlMode` in `playlist-route.ts` reads the mode the API put
 * in the URL — so every failure here is now reported AS a failure, with a
 * reason, and `index.ts` turns it into a retryable `503`. See that call
 * site.
 *
 * `fetchPlaylist` renders with `LL_TOKEN_PLACEHOLDER`, never a real token —
 * see `ll-playlist.js`'s header. This is what lets `index.ts` cache and
 * coalesce an LL rendition response exactly like a conventional one; a
 * Farol review of this PR's first draft caught that embedding the real
 * token here leaked one viewer's bearer credential into the shared
 * cache/coalescer's entry, readable by every other viewer who hit it warm.
 *
 * A CONVENTIONAL MASTER REQUEST NEVER REACHES THIS FILE AT ALL ANY MORE.
 * `index.ts` only calls `fetchMultivariantPlaylist` when the request itself
 * says `mode=ll`, so the conventional master route is byte-for-byte the API
 * forward it was before LL existed: no probe, no added latency, and an
 * unhealthy LL origin cannot hold a conventional viewer's join open for a
 * moment. That was two separate Farol findings against the probing version,
 * and the explicit marker retires both rather than tuning them.
 *
 * WHAT THE TWO REMAINING BOUNDS ARE FOR. `MASTER_PROBE_TIMEOUT_MS` is how
 * long an LL master request waits on `state.json` before answering "not
 * ready" — short, because a healthy remux rewrites that file every part and
 * a player that is told to come back in a second loses a second, where a
 * player held open loses the request. The underlying fetch is never aborted
 * when the deadline wins: it keeps running under its own `timeoutMs` and
 * whatever it settles on is remembered in `notReadyCache`, so the next
 * arrival within `NOT_READY_CACHE_TTL_MS` is answered without a second
 * origin fetch. Five hundred viewers joining a warming session therefore
 * cost the remux about one `state.json` fetch a second, not five hundred.
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

/** See this file's header, "WHAT THE TWO REMAINING BOUNDS ARE FOR" — deliberately much shorter than the `timeoutMs` the underlying origin fetch still runs under. */
const MASTER_PROBE_TIMEOUT_MS = 1_500;

/**
 * How long a (channelId, startedAt) just found NOT READY is answered that
 * way without asking the origin again.
 *
 * ONE SECOND, NOT FIVE. Its predecessor cached "this session is not LL" for
 * five seconds, which was the right shape for a question asked once per
 * party; this one caches "the LL session is still warming up", which is the
 * state EVERY LL session passes through in its first moments and leaves for
 * good. Holding that answer for five seconds would add five seconds of black
 * to the start of every low-latency party. One second is long enough to
 * collapse a join burst and short enough that nobody waits on a session that
 * is already writing.
 */
const NOT_READY_CACHE_TTL_MS = 1_000;

/** Same bounded-map shape as `videoCodecCache` below — a churn of distinct (channelId, startedAt) pairs must not grow this forever. */
const NOT_READY_CACHE_MAX_ENTRIES = 500;

/** Thrown internally by `raceProbe` when `MASTER_PROBE_TIMEOUT_MS` elapses before the underlying fetch settles — never thrown across this module's own public API. */
class MasterProbeTimeoutError extends Error {}

/**
 * Why an LL master could not be built right now. Every one of these is
 * TEMPORARY by construction — an LL session whose state has not been written
 * yet, an origin that is slow or down, an init segment not fully flushed —
 * which is what makes `503 Retry-After` the honest answer rather than a
 * fallback to a ladder nobody is writing. Carried through to
 * `hlsEdge.llMasterNotReady` so an operator can tell a warming remux apart
 * from a dead one without a packet capture (pitfall 16's rule: an endpoint
 * that refuses somebody must say why).
 */
export type LlMasterNotReadyReason =
  | "no-state"
  | "probe-timeout"
  | "origin-error"
  | "build-failed";

export type LlMultivariantResult =
  | { kind: "ready"; response: Response }
  | { kind: "not-ready"; reason: LlMasterNotReadyReason };

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
   * `(channelId, startedAt)` key -> the last "not ready" answer and when it
   * was observed. Checked ONLY by `fetchMultivariantPlaylist` — see this
   * file's header. Never consulted by `fetchPlaylist` (the rendition route):
   * a viewer only ever asks for `ll`/`ll-audio` because a master response
   * already handed them that rung name, so that route has nothing to
   * short-circuit.
   */
  private readonly notReadyCache = new Map<
    string,
    { at: number; reason: LlMasterNotReadyReason }
  >();

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
   * `playlist-route.ts` bounded it to the same pattern and `ll-media.ts`
   * bounded it to a NARROWER one (the filenames the remux actually writes):
   * this method
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
   * The multivariant playlist for the session/master route of a request that
   * ASKED for LL (`requestsLlMode`, `playlist-route.ts`), or a `not-ready`
   * with a reason. Never "fall back to conventional": the caller has already
   * been told by the API which mode this session is, and there is no
   * conventional ladder running for an LL one — see this file's header.
   * Called directly, per request, with the CALLER's own real token (this
   * route is never cached — see `ll-playlist.js`'s header and `index.ts`'s
   * own comment on the session/master route for why that has always been
   * true, LL or not).
   */
  async fetchMultivariantPlaylist(
    channelId: string,
    startedAt: string,
    token: string,
  ): Promise<LlMultivariantResult> {
    const probeKey = `${channelId}:${startedAt}`;
    const remembered = this.recentNotReady(probeKey);
    if (remembered) {
      return { kind: "not-ready", reason: remembered };
    }
    // Started once, awaited with a SHORT deadline below -- but never
    // aborted when that deadline wins, so a slow-but-eventually-answering
    // origin still gets to populate `notReadyCache` for the benefit of the
    // NEXT master request, even though THIS one already answered 503. See
    // this file's header, "WHAT THE TWO REMAINING BOUNDS ARE FOR".
    const statePromise = this.fetchState(channelId, startedAt);
    statePromise.then(
      (result) => {
        if (!result) {
          this.rememberNotReady(probeKey, "no-state");
        }
      },
      () => {
        this.rememberNotReady(probeKey, "origin-error");
      },
    );
    let found: { sessionId: string; state: LlSessionState } | null;
    try {
      found = await this.raceProbe(statePromise, MASTER_PROBE_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof MasterProbeTimeoutError) {
        logEvent("hlsEdge.llMasterProbeTimedOut", { channelId, timeoutMs: MASTER_PROBE_TIMEOUT_MS });
        // NOT remembered: the underlying fetch is still running and its own
        // `.then` above writes the memo with the answer it actually gets. A
        // timeout is this request giving up, not a verdict about the session.
        return { kind: "not-ready", reason: "probe-timeout" };
      }
      logEvent("hlsEdge.llStateFetchFailed", { channelId, error: String(error) });
      return { kind: "not-ready", reason: "origin-error" };
    }
    if (!found) {
      return { kind: "not-ready", reason: "no-state" };
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
      return {
        kind: "ready",
        response: new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" },
        }),
      };
    } catch (error) {
      logEvent("hlsEdge.llMultivariantBuildFailed", {
        channelId,
        sessionId: found.sessionId,
        error: String(error),
      });
      // Remembered like a missing state: an init segment this file cannot
      // read is almost always one the remux has only half written, which the
      // next second fixes on its own.
      this.rememberNotReady(probeKey, "build-failed");
      return { kind: "not-ready", reason: "build-failed" };
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

  /** The reason `key` was last found not ready, if that was within `NOT_READY_CACHE_TTL_MS` — see `notReadyCache`'s doc comment. */
  private recentNotReady(key: string): LlMasterNotReadyReason | null {
    const entry = this.notReadyCache.get(key);
    if (!entry || Date.now() - entry.at >= NOT_READY_CACHE_TTL_MS) {
      return null;
    }
    return entry.reason;
  }

  private rememberNotReady(key: string, reason: LlMasterNotReadyReason): void {
    if (this.notReadyCache.size >= NOT_READY_CACHE_MAX_ENTRIES && !this.notReadyCache.has(key)) {
      const oldestKey = this.notReadyCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.notReadyCache.delete(oldestKey);
      }
    }
    this.notReadyCache.set(key, { at: Date.now(), reason });
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

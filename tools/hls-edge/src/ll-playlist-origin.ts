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

/** Bound on the per-session codec cache — same shape as `index.ts`'s `rejectionLog`: a churn of many short LL sessions must not grow this forever. */
const CODEC_CACHE_MAX_ENTRIES = 200;

interface CachedCodecs {
  videoCodec: string;
  videoWidth: number;
  videoHeight: number;
  audioCodec: string | null;
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

export class LlPlaylistOrigin implements PlaylistOrigin {
  private readonly codecCache = new Map<string, CachedCodecs>();

  constructor(
    private readonly originBase: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  get ready(): boolean {
    return Boolean(this.originBase);
  }

  /** One bounded fetch against the remux origin (state.json or an init segment) — never a viewer-facing route. */
  private async fetchFromOrigin(path: string): Promise<Response> {
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
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `sessionId` (recomputed, never looked up — `ll-session.js`) plus the
   * parsed `state.json`, or `null` when this specific (channelId, startedAt)
   * has no LL session at all (a plain 404 from the origin — the ordinary
   * "this party is conventional" case, not a failure).
   */
  private async fetchState(
    channelId: string,
    startedAt: string,
  ): Promise<{ sessionId: string; state: LlSessionState } | null> {
    const sessionId = await deriveLlSessionId(channelId, Number(startedAt));
    const response = await this.fetchFromOrigin(statePath(sessionId));
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`state.json fetch failed: ${response.status}`);
    }
    const parsed = parseLlState(await response.json());
    if (!parsed) {
      throw new Error("state.json failed validation");
    }
    return { sessionId, state: parsed };
  }

  /**
   * `PlaylistOrigin.fetchPlaylist`: one rung's LL media playlist. Only ever
   * called by `index.ts` for `rung === LL_VIDEO_RUNG || LL_AUDIO_RUNG` — see
   * that file's origin-selection comment.
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
    const text = buildLlRenditionPlaylist(found.state, track, req.rung, {
      basePath,
      token: req.token,
    });
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" },
    });
  }

  /**
   * The multivariant playlist for the session/master route, or `null` when
   * this Worker should not answer with one at all (no LL session; origin
   * unreachable; a `state.json` or init segment this file can't make sense
   * of). See this file's header, "FAILS TOWARD...".
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
      const codecs = await this.codecsFor(found.sessionId, found.state);
      const basePath = renditionBasePath(channelId, startedAt);
      const text = buildLlMultivariantPlaylist(found.state, {
        basePath,
        token,
        videoCodec: codecs.videoCodec,
        videoWidth: codecs.videoWidth,
        videoHeight: codecs.videoHeight,
        audioCodec: codecs.audioCodec,
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

  /** Codec strings never change for a session's lifetime, so one successful read is cached for every later master request this isolate serves. */
  private async codecsFor(sessionId: string, state: LlSessionState): Promise<CachedCodecs> {
    const cached = this.codecCache.get(sessionId);
    if (cached) {
      return cached;
    }
    const videoInitResponse = await this.fetchFromOrigin(originAssetPath(sessionId, state.video.initUri));
    if (!videoInitResponse.ok) {
      throw new Error(`video init fetch failed: ${videoInitResponse.status}`);
    }
    const videoInfo = extractAvc1VideoInfo(await videoInitResponse.arrayBuffer());
    if (!videoInfo) {
      throw new Error("video init segment did not yield an avcC box");
    }
    // AAC-LC never varies for this pipeline (`ll-init-codecs.js`'s own doc
    // comment) — no need to fetch and parse `audio-init.mp4`'s `esds` box
    // just to learn a constant.
    const audioCodec = state.audio ? AAC_LC_CODEC : null;
    const result: CachedCodecs = {
      videoCodec: videoInfo.codec,
      videoWidth: videoInfo.width,
      videoHeight: videoInfo.height,
      audioCodec,
    };
    if (this.codecCache.size >= CODEC_CACHE_MAX_ENTRIES) {
      const oldestKey = this.codecCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.codecCache.delete(oldestKey);
      }
    }
    this.codecCache.set(sessionId, result);
    return result;
  }
}

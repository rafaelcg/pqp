import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/utils";
import {
  LIVE_HLS_TELEMETRY_FLUSH_MS,
  type LiveHlsTelemetryBatch,
  type LiveHlsTelemetrySample,
} from "@pqp/shared";

const HLS_PLAYLIST_PROXY_PATH = "/api/voice/hls-playlist/";

/**
 * `LiveHlsStream.hlsUrl` from the server is either a full public URL
 * (`LIVE_HLS_SIGNED_URLS=false`, or the raw bucket base) or an API-relative
 * path to the signed playlist proxy. This turns the latter into something a
 * player can actually fetch.
 */
export function resolveHlsUrl(hlsUrl: string): string {
  if (hlsUrl.startsWith("http://") || hlsUrl.startsWith("https://")) {
    return hlsUrl;
  }
  return `${getApiBaseUrl()}${hlsUrl}`;
}

/**
 * Both of a stream's playlists, resolved.
 *
 * A stream now carries two URLs — the film and, when the presenter has a
 * camera on, a second video-only playlist for it — and they arrive by four
 * different doors (`voice-stream`, `channel-live`, the one-shot
 * `GET /api/channels/:id/live`, and the player's own reconnect). Resolving
 * them field by field at each door is how one of them ends up API-relative and
 * unplayable at exactly one of the four, which is the sort of thing that shows
 * up during somebody's film. One function, one rule.
 *
 * Generic over the stream shape so the four call sites keep their own types:
 * the field is optional on the wire (older servers, iOS, Android) and stays
 * optional here.
 */
export function resolveLiveHlsStream<
  T extends { hlsUrl: string; cameraHlsUrl?: string },
>(stream: T): T {
  return {
    ...stream,
    hlsUrl: resolveHlsUrl(stream.hlsUrl),
    ...(stream.cameraHlsUrl
      ? { cameraHlsUrl: resolveHlsUrl(stream.cameraHlsUrl) }
      : {}),
  };
}

/**
 * WHICH SESSION A PLAYLIST URL NAMES, ignoring the query string.
 *
 * THE BUG THIS EXISTS FOR. `hlsUrl` is stamped per recipient with a signed
 * `?t=` token, and the server restamps it on the audience keyframe, which is
 * every 30 seconds while a channel is live. So the string a viewer holds
 * changes twice a minute for a stream that has not changed at all. The web
 * player re-attached its `<video>` on any change of `src`, so **every seatless
 * web viewer rebuffered every 30 seconds, for the whole film**, on every watch
 * party there has ever been. iOS was given exactly this fix when the audience
 * half was written (`WatchStreamSwap` swaps on `startedAt`, on a failure and on
 * the token clock); the web never was, and the symptom on both is identical, so
 * it read as one shared problem with the stream rather than one platform
 * missing a guard.
 *
 * The session is the path: `/api/voice/hls-playlist/<channelId>/<startedAt>`,
 * which changes exactly when the egress restarts, which is the only time a
 * viewer genuinely has to move. A URL that is not the proxy's (a raw public
 * bucket URL, `LIVE_HLS_SIGNED_URLS=false`) has no token to strip and is its
 * own key.
 */
export function hlsSessionKey(url: string | null): string | null {
  if (!url) {
    return null;
  }
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** Two playlist URLs that differ only by their per-viewer token. */
export function sameHlsSession(a: string | null, b: string | null): boolean {
  return hlsSessionKey(a) === hlsSessionKey(b);
}

/**
 * Whether an incoming playlist URL is a different session and must re-attach.
 *
 * A restamped `?t=` on the same path is NOT a new session. Adopting it
 * tears hls.js down, drops the buffer, and is the stall that looked like
 * the stream dying twice a minute. `null` means nothing is attached yet.
 */
export function shouldAdoptHlsSource(
  attachedSessionKey: string | null,
  incomingUrl: string,
): boolean {
  const incoming = hlsSessionKey(incomingUrl);
  return attachedSessionKey === null || attachedSessionKey !== incoming;
}

/**
 * What a same-session `src` prop change should do to the loader's freshest
 * known playlist token, without ever touching `activeSrc` or re-attaching
 * hls.js. `null` means "this is an attach, not a restamp" -- the caller's
 * own adopt branch handles that case, including resetting the ref to the
 * new `activeSrc` itself.
 *
 * THE BUG THIS EXISTS FOR (Farol review, PR 570). The server restamps a
 * playlist's `?t=` on every audience keyframe, and that restamped URL
 * arrives here as a same-session `src` prop change -- `shouldAdoptHlsSource`
 * correctly says not to re-attach for it, but the effect used to just
 * return on that branch without doing anything else, so the fresher token
 * was silently dropped. It reached the loader only when `reconnect()`'s own
 * `fetchChannelLive` poll happened to run in between, which left the token
 * stale for as long as the stream stayed healthy and quiet.
 */
export function nextFreshPlaylistUrl(
  attachedSessionKey: string | null,
  incomingUrl: string,
): string | null {
  if (shouldAdoptHlsSource(attachedSessionKey, incomingUrl)) {
    return null;
  }
  return incomingUrl;
}

/**
 * Whether a playlist URL already carries its own per-viewer capability.
 *
 * The one question `xhrSetup` has to ask before attaching a Bearer header. A
 * URL with `?t=` authorises itself, and adding a Clerk JWT beside it can only
 * make the request WORSE: `handleApi` resolves a Bearer ahead of the router,
 * so a JWT that has expired in the last few seconds turns a request the
 * capability would have served into a 401. That is exactly what stalled every
 * web viewer of every watch party, roughly once a minute, for as long as the
 * feature has existed.
 */
export function hasHlsViewerToken(url: string): boolean {
  const query = url.indexOf("?");
  if (query === -1) {
    return false;
  }
  return new URLSearchParams(url.slice(query + 1)).has("t");
}

/**
 * Swap a fresher `?t=` capability into an outgoing playlist request, keeping
 * everything else about it -- INCLUDING A RUNG'S OWN PATH SUFFIX, which
 * `sameHlsSession` deliberately does not consider equal to the master
 * (`sameHlsSession(SESSION, \`${SESSION}/720p30\`) === false`). A live
 * stream's actual repeated fetching is the rung's media playlist, not the
 * master, so a token swap that only matched an exact `sameHlsSession` would
 * never reach the one request that needed it.
 *
 * WHY THIS EXISTS (`BROADCAST_PIPELINE.md` B1.3, item 3). A restamped token
 * used to be adopted by re-attaching hls.js entirely -- dropping the buffer
 * for a change that never touched the media timeline. This is the
 * loader-level alternative: `xhrSetup` calls this on every request against
 * our own playlist proxy, and a fresher token found here reaches hls.js
 * through the URL it fetches rather than through a rebuilt instance.
 *
 * `url` and `freshUrl` are treated as the same session when `url`'s path
 * (query stripped) either equals `freshUrl`'s or extends it with a further
 * segment (`/720p30`, a rung); anything else -- a different channel, a
 * different `startedAt`, a raw unsigned bucket URL with no token to swap --
 * is left untouched.
 */
export function withFreshHlsToken(url: string, freshUrl: string): string {
  const freshToken = hasHlsViewerToken(freshUrl)
    ? new URLSearchParams(freshUrl.slice(freshUrl.indexOf("?") + 1)).get("t")
    : null;
  if (!freshToken) {
    return url;
  }
  const urlPath = hlsSessionKey(url);
  const freshPath = hlsSessionKey(freshUrl);
  if (
    urlPath === null ||
    freshPath === null ||
    (urlPath !== freshPath && !urlPath.startsWith(`${freshPath}/`))
  ) {
    return url;
  }
  const query = url.indexOf("?");
  const params = new URLSearchParams(query === -1 ? "" : url.slice(query + 1));
  if (params.get("t") === freshToken) {
    // Already carrying this exact token; nothing to rewrite.
    return url;
  }
  params.set("t", freshToken);
  return `${urlPath}?${params.toString()}`;
}

/**
 * The `?t=` HLS viewer token a playlist URL carries, or null. This is the
 * SAME capability `hasHlsViewerToken` above only checks for the presence of
 * -- here it is read out so `hls-watch-player.tsx` can hand it to the
 * telemetry route, which verifies it server-side and uses the channel/session
 * it names instead of trusting a client-typed `sessionId` string (Farol
 * finding, 2026-09-13: "authenticated users can submit telemetry for
 * arbitrary sessions"). Null for a URL with no query string at all, or one
 * whose query does not carry `t` -- the `LIVE_HLS_SIGNED_URLS=false`
 * configuration, which mints no such token (`stampViewerStream`).
 */
export function hlsViewerTokenFromUrl(url: string): string | null {
  const query = url.indexOf("?");
  if (query === -1) {
    return null;
  }
  return new URLSearchParams(url.slice(query + 1)).get("t");
}

/**
 * Whether a URL hls.js is about to fetch is our own signed playlist proxy --
 * the one request in the whole HLS pipeline that needs a Bearer header. Every
 * segment/media URL the proxy hands back is already an absolute, presigned
 * bucket URL and must NOT get our Authorization header attached: that would
 * leak a user's Clerk-derived token to a third-party origin (R2) and, for a
 * SigV4-signed request, would not even be the right kind of credential.
 *
 * KEYED ON THE PATH, NOT THE HOST, and that is the fix for a stall rather
 * than a tidy-up (2026-09-19, channel d5559e70). The proxy path
 * (`/api/voice/hls-playlist/`) is what identifies our playlist on whatever
 * host serves it: the API origin (`VITE_API_URL`) by default, OR an edge host
 * (`LIVE_HLS_PLAYLIST_BASE_URL`, e.g. `hls.pqp.gg`) once an operator has moved
 * playlist delivery off the API box, which production has. The old rule
 * matched `getApiBaseUrl()` (the API origin) as a prefix, so every
 * `hls.pqp.gg` playlist URL returned FALSE — and with it the conventional
 * restart fast path (`isPlaylistGoneError` -> hold -> discover) and the
 * loader token swap both silently stopped running, so a viewer whose egress
 * restarted hammered the DEAD `startedAt` for minutes (502/503/404 in a loop)
 * instead of adopting the new session. A raw public bucket URL
 * (`LIVE_HLS_SIGNED_URLS=false`) carries no such path and stays excluded,
 * exactly as before — it is its own session key and never takes a Bearer.
 */
export function isOwnHlsPlaylistProxyUrl(url: string): boolean {
  try {
    // Resolve relative URLs (dev, empty `VITE_API_URL`) against a real base;
    // an absolute URL ignores the base, so the edge host is matched on path.
    const base =
      getApiBaseUrl() ||
      (typeof window !== "undefined" ? window.location.origin : "http://localhost");
    return new URL(url, base).pathname.startsWith(HLS_PLAYLIST_PROXY_PATH);
  } catch {
    // Not a parseable URL: fall back to the old prefix rule and a bare path.
    return (
      url.startsWith(`${getApiBaseUrl()}${HLS_PLAYLIST_PROXY_PATH}`) ||
      url.startsWith(HLS_PLAYLIST_PROXY_PATH)
    );
  }
}

export interface HlsPlaybackStats {
  width: number;
  height: number;
  droppedVideoFrames?: number;
  totalVideoFrames?: number;
}

/** `HTMLVideoElement.getVideoPlaybackQuality()`, when the engine has it. */
export function sampleVideoPlaybackQuality(video: {
  getVideoPlaybackQuality?: () => {
    droppedVideoFrames: number;
    totalVideoFrames: number;
  };
}): { droppedVideoFrames: number; totalVideoFrames: number } | null {
  if (typeof video.getVideoPlaybackQuality !== "function") {
    return null;
  }
  const quality = video.getVideoPlaybackQuality();
  if (
    !quality ||
    typeof quality.droppedVideoFrames !== "number" ||
    typeof quality.totalVideoFrames !== "number"
  ) {
    return null;
  }
  return {
    droppedVideoFrames: quality.droppedVideoFrames,
    totalVideoFrames: quality.totalVideoFrames,
  };
}

let stats: HlsPlaybackStats | null = null;
const listeners = new Set<(next: HlsPlaybackStats | null) => void>();

export function setHlsPlaybackStats(next: HlsPlaybackStats | null): void {
  stats = next;
  for (const listener of listeners) {
    listener(next);
  }
}

export function useHlsPlaybackStats(): HlsPlaybackStats | null {
  const [value, setValue] = useState(stats);
  useEffect(() => {
    listeners.add(setValue);
    setValue(stats);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

let hlsRebuildCount = 0;
const rebuildListeners = new Set<(next: number) => void>();

/**
 * A full hls.js instance was torn down and recreated -- the recovery
 * ladder's last resort (`hls-stall.ts`), a genuinely new session, or a
 * person's own "try again". Counted here rather than only logged, so B0's
 * telemetry hook (`BROADCAST_PIPELINE.md`) has a number to read instead of
 * having to scrape the console; `useHlsRebuildCount` is the same
 * subscribe-on-mount shape as `useHlsPlaybackStats` above.
 */
export function recordHlsRebuild(): number {
  hlsRebuildCount += 1;
  for (const listener of rebuildListeners) {
    listener(hlsRebuildCount);
  }
  return hlsRebuildCount;
}

/** Total rebuilds this tab has recorded, across every stream so far. */
export function getHlsRebuildCount(): number {
  return hlsRebuildCount;
}

export function useHlsRebuildCount(): number {
  const [value, setValue] = useState(hlsRebuildCount);
  useEffect(() => {
    rebuildListeners.add(setValue);
    setValue(hlsRebuildCount);
    return () => {
      rebuildListeners.delete(setValue);
    };
  }, []);
  return value;
}

/** Test-only: this module's counter otherwise leaks between vitest cases. */
export function resetHlsRebuildCountForTest(): void {
  hlsRebuildCount = 0;
  for (const listener of rebuildListeners) {
    listener(hlsRebuildCount);
  }
}

export type HlsEngine = "hlsjs" | "native" | "none";

/**
 * Which player gets the playlist.
 *
 * `canPlayType` is not the tiebreaker it looks like. Chrome 152 on macOS
 * answers "maybe" for `application/vnd.apple.mpegurl`, then sits at
 * readyState 0 forever with no `error` event once the playlist is set as
 * `src` (verified against the staging egress on 2026-09-08). Trusting that
 * answer put every Chrome viewer on the native path and left them on
 * "Loading the stream" while hls.js, which plays the same playlist fine,
 * was never imported. So MSE wins whenever it exists; the native player is
 * only for the browsers that have no MSE at all, which today means older
 * iPhones. Desktop Safari has MSE and plays through hls.js too.
 */
export function chooseHlsEngine(input: {
  /** `video.canPlayType("application/vnd.apple.mpegurl")`. */
  nativeHls: string;
  /** `Hls.isSupported()`. */
  mseSupported: boolean;
}): HlsEngine {
  if (input.mseSupported) {
    return "hlsjs";
  }
  if (input.nativeHls !== "") {
    return "native";
  }
  return "none";
}

/** `play()` refused for want of a gesture, as opposed to a broken stream. */
export function isAutoplayRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "NotAllowedError"
  );
}

// ---------------------------------------------------------------------------
// BROADCAST_PIPELINE B0.3/B0.5: encode-to-paint latency and its telemetry.
// ---------------------------------------------------------------------------

/**
 * A `#EXT-X-PQP-SESSION`-carrying `hls_sessions.id` would be the honest join
 * key for a telemetry batch (the same id `voice.hls*` log lines carry, since
 * B0.4), but hls.js's manifest parser does not expose our own custom comment
 * tags anywhere on the events this player already listens to, and reaching it
 * would mean either a second, redundant playlist fetch on this component's
 * own initiative or a new prop threaded through every caller of
 * `HlsWatchPlayer` -- including one in `components/watch-party/`, which this
 * change does not touch. So this is the fallback the schema's `sessionId`
 * field allows (`z.string().min(1).max(64)`, no format requirement): the
 * channel and `startedAt` the player is actually attached to, which is
 * EXACTLY what names one party session everywhere else in this codebase
 * predates B0.4 (`sessionPrefixPattern`, every cache key in
 * `hls-playlist-proxy.ts`). It groups a viewer's samples by party correctly;
 * it is just not literally the same string as the DB row id. Wiring the real
 * id through requires a `LiveHlsStream.sessionId` field and a prop on every
 * caller, left for a follow-up.
 */
const HLS_PLAYLIST_SESSION_KEY_RE =
  /\/api\/voice\/hls-playlist\/([^/?]+)\/(\d+)(?:\/[^/?]+)?/;

export function hlsTelemetrySessionKey(url: string): string | null {
  const match = HLS_PLAYLIST_SESSION_KEY_RE.exec(url);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }
  // Not our proxy: `LIVE_HLS_SIGNED_URLS=false` hands out the raw public
  // bucket URL directly (a supported configuration -- see `resolveHlsUrl`),
  // and that stream is just as worth measuring. `hlsSessionKey` already
  // strips the query string, which is the only thing that varies on this
  // URL shape (nothing re-signs it per viewer the way the proxy's `?t=`
  // does), so what is left is stable for the life of the session.
  return hlsSessionKey(url);
}

/**
 * Which rung a media playlist URL names, e.g. `720p30` -- the same path
 * segment `hls-playlist-proxy.ts` reads on the server. Null for a master
 * (no-rung) URL or anything that is not this proxy at all.
 */
const HLS_PLAYLIST_RUNG_RE =
  /\/api\/voice\/hls-playlist\/[^/?]+\/\d+\/([^/?]+)/;

export function hlsRungFromPlaylistUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = HLS_PLAYLIST_RUNG_RE.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * A rung label for a level whose URL is not our own proxy at all (a Farol
 * finding, 2026-09-13: `LIVE_HLS_SIGNED_URLS=false` hands out a raw public
 * bucket URL with no rung in its path, so `hlsRungFromPlaylistUrl` above
 * always returns null for it and telemetry silently never had a rung to
 * report). Built from the level's own declared resolution and framerate the
 * same way this repo names a rung everywhere else (`hls-ladder.ts`'s
 * `LADDER_RUNGS` keys: `<height>p<framerate>`), so a level matching a real
 * ladder rung produces the SAME string the server already knows; one that
 * does not is refused by the server's own rung whitelist rather than
 * silently mislabelled, which is the safer failure for a metric.
 */
export function hlsFallbackRungLabel(
  level: { height?: number; framerate?: number } | null | undefined,
): string | null {
  if (!level?.height || !level.framerate) {
    return null;
  }
  return `${level.height}p${Math.round(level.framerate)}`;
}

/**
 * The sampling identity for `isSampledForHlsTelemetry`, read off whatever
 * `getAuthToken()` already resolved -- so this needs no Clerk hook of its
 * own, which matters because `HlsWatchPlayer` renders under the dev-auth
 * bypass too, where there is no `ClerkProvider` in the tree at all and a
 * direct `useAuth()` call would throw.
 *
 * A Clerk JWT's middle segment carries a `sub` claim (the Clerk user id);
 * read UNVERIFIED, because this is a client-side sampling coin flip, not an
 * access decision, and the worst a forged token buys is landing on the wrong
 * side of a 10% split. The dev-auth bypass token (`dev-local-token[:suffix]`)
 * is not a JWT at all and is used as-is: stable per browser/suffix, which is
 * all sampling needs, and it is how `alice`/`bob`/`carol` in local dev land
 * on different sides of the split for testing.
 */
export function hlsTelemetryIdentityFromToken(token: string | null): string | null {
  if (!token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(base64)) as { sub?: unknown };
      if (typeof payload.sub === "string" && payload.sub) {
        return payload.sub;
      }
    } catch {
      // Not a JWT this can read, or no `sub` claim. Fall through.
    }
  }
  return token;
}

/**
 * One fragment's wall clock, from `#EXT-X-PROGRAM-DATE-TIME` as hls.js parses
 * it: `programDateTimeMs` is the epoch millisecond the fragment STARTS at,
 * `startSeconds` is the same fragment's start on the playlist's own time
 * axis. Together they let a later media time on the same axis be converted
 * back to a wall clock.
 */
export interface FragPdtInfo {
  programDateTimeMs: number;
  startSeconds: number;
}

/**
 * Encode-to-paint latency, milliseconds (BROADCAST_PIPELINE B0.3, the T4-T8
 * span): wall clock now, minus the wall clock of the media time that was
 * just painted, computed from the currently active fragment's own PDT.
 *
 * `paintedMediaTimeSeconds` is `video.currentTime` (a periodic fallback) or,
 * where the browser has it, the `mediaTime` a
 * `video.requestVideoFrameCallback` callback reports for the frame it was
 * just called for -- the more precise of the two, since `currentTime` can
 * run slightly ahead of what is actually on screen.
 *
 * NEVER folds in capture-to-encode (T0-T4): that half is a separate,
 * unstamped ESTIMATE (see `docs/plans/BROADCAST_PIPELINE.md` B0.3's table)
 * and must be reported alongside this number, never added into it, so a
 * server aggregating this value never silently mixes a measurement with a
 * guess.
 *
 * Null when the active fragment carries no usable PDT at all (a source this
 * player was never meant to see: not our proxy, or a build old enough to
 * predate B0.2's synthesis). Floored at 0: a negative result is clock skew
 * between this browser and the egress box, not a real negative latency, and
 * reporting the raw negative number would let one skewed clock drag a whole
 * rung's p50 into something that reads as "impossibly fast" instead of
 * "encode-to-paint is one to two orders of magnitude smaller than clock
 * skew usually is, so treat this reading as unreliable and move on".
 */
export function encodeToPaintLatencyMs(
  frag: FragPdtInfo,
  paintedMediaTimeSeconds: number,
  nowMs: number = Date.now(),
): number | null {
  if (!Number.isFinite(frag.programDateTimeMs) || frag.programDateTimeMs <= 0) {
    return null;
  }
  const frameWallClockMs =
    frag.programDateTimeMs +
    (paintedMediaTimeSeconds - frag.startSeconds) * 1000;
  const latencyMs = nowMs - frameWallClockMs;
  return latencyMs < 0 ? 0 : latencyMs;
}

/**
 * A per-viewing-session batching queue (BROADCAST_PIPELINE B0.5): buffers
 * samples in memory and flushes them on an interval, never on push. An empty
 * buffer costs nothing -- `flush` is a no-op rather than an empty POST -- so
 * a sampled viewer sitting on a paused, buffered stream sends nothing until
 * playback (and therefore a fresh sample) resumes.
 */
export interface HlsTelemetryQueue {
  push(sample: LiveHlsTelemetrySample): void;
  /** Flush now, bypassing the timer. Used on unmount so the last window is not lost. */
  flush(): void;
  stop(): void;
  /**
   * Update the cached Bearer token a future flush sends. The caller (this
   * queue has no Clerk hook of its own) already polls a fresh token on an
   * interval for the `xhrSetup` path (`hls-watch-player.tsx`'s
   * `refreshAuthToken`); calling this alongside that keeps the SAME token in
   * hand here, so a flush never has to go fetch one itself -- see `flush`'s
   * own comment on why that matters.
   */
  setToken(token: string | null): void;
}

export function createHlsTelemetryQueue(input: {
  sessionId: string;
  /**
   * The `?t=` viewer token the playlist request carried, when there was one
   * (`hlsViewerTokenFromUrl`) -- forwarded on every flush so the server can
   * bind this batch to the session ITS OWN signature names, rather than
   * trusting `sessionId` above as free text (Farol finding, 2026-09-13).
   * Absent for the `LIVE_HLS_SIGNED_URLS=false` configuration, which mints no
   * token at all; that batch is still sent, on `sessionId` alone.
   */
  sessionToken?: string | null;
  /**
   * The Bearer token to send with the FIRST flush, cached rather than
   * fetched -- see `flush`'s own comment. `setToken` on the returned queue
   * updates it as the caller's own token refresh resolves.
   */
  token?: string | null;
  send: (batch: LiveHlsTelemetryBatch, token: string | null) => void;
  flushMs?: number;
  setInterval?: typeof window.setInterval;
  clearInterval?: typeof window.clearInterval;
}): HlsTelemetryQueue {
  const setIntervalFn = input.setInterval ?? window.setInterval.bind(window);
  const clearIntervalFn = input.clearInterval ?? window.clearInterval.bind(window);
  let buffer: LiveHlsTelemetrySample[] = [];
  let token: string | null = input.token ?? null;
  function flush() {
    if (buffer.length === 0) {
      return;
    }
    const samples = buffer;
    buffer = [];
    // The token is READ, never fetched, here -- no `await` runs before
    // `input.send` (and, inside it, `fetch`) is called. The unmount flush
    // (`HlsWatchPlayer`'s cleanup) fires this same path on a navigate-away,
    // and a page that is unloading is not guaranteed to run any code after
    // an `await` at all: a batch that looked async-but-fine in every manual
    // test silently lost its samples on a real tab close (a Farol finding,
    // 2026-09-14). `keepalive: true` on the `fetch` itself (in `send`) is
    // what actually keeps the request alive past unload; this only makes
    // sure nothing delays ISSUING it.
    input.send(
      {
        sessionId: input.sessionId,
        ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
        samples,
      },
      token,
    );
  }
  const timer = setIntervalFn(flush, input.flushMs ?? LIVE_HLS_TELEMETRY_FLUSH_MS);
  return {
    push(sample) {
      buffer.push(sample);
    },
    flush,
    stop() {
      clearIntervalFn(timer);
      buffer = [];
    },
    setToken(next) {
      token = next;
    },
  };
}

/**
 * The one POST this feature makes. Fire-and-forget by design: a rejected or
 * failed batch is a no-op the caller never retries (see
 * `POST /api/live-hls/telemetry`'s own doc comment on the server) -- this is
 * a measurement, not an event anything downstream is waiting on.
 *
 * `token` is a plain, already-resolved value, NOT fetched here. It used to
 * be `getToken: () => Promise<string | null>`, awaited before `fetch` ran --
 * which meant the unmount flush (`HlsWatchPlayer`'s cleanup, on a
 * navigate-away) awaited an async token lookup before issuing a request that
 * itself depends on the page still being around to run that continuation.
 * `keepalive: true` keeps a request ALIVE past unload; it does nothing for
 * one that was never issued because the tab closed between the `await` and
 * the `fetch`. Measured against a real tab close on 2026-09-14: the final
 * batch was silently lost every time (a Farol finding). The caller
 * (`HlsTelemetryQueue`) now caches the last resolved token itself, so this
 * function has one left to read synchronously and calls `fetch` with
 * nothing awaited first.
 */
export function sendHlsTelemetryBatch(
  batch: LiveHlsTelemetryBatch,
  token: string | null,
): void {
  fetch(`${getApiBaseUrl()}/api/live-hls/telemetry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(batch),
    // The unmount flush (`HlsWatchPlayer`'s cleanup) fires this same path on
    // a navigate-away, and an ordinary fetch is exactly the request class
    // the browser is free to abort once the document starts unloading (a
    // Farol finding, 2026-09-13). `keepalive` is the documented escape hatch
    // for "send this even if the page is going away" and, unlike
    // `navigator.sendBeacon`, still allows the Authorization header this
    // route requires. The body is a handful of samples -- nowhere near the
    // ~64 KiB keepalive budget browsers share across all such requests.
    keepalive: true,
  }).catch(() => {
    // Dropped. See the doc comment above.
  });
}

/**
 * WHAT A STALL COSTS, PER TELEMETRY SAMPLE (2026-09-23).
 *
 * The first cut of this telemetry counted `waiting` AND `stalled` events and
 * never sent a duration, so the 2026-09-21 party could only say "33% of
 * 30-second windows had a stall": every attach's own startup buffering
 * counted, a network `stalled` notice on a playing element counted, and a
 * 40 ms blip weighed the same as a 20 s freeze. This meter counts EPISODES
 * (a `waiting` that was not already inside one; the gap controller's
 * seek-over-hole fires a second `waiting` inside the same freeze) and their
 * frozen milliseconds, split at sample boundaries so a long freeze is
 * reported as it happens rather than only when it ends.
 *
 * Pure: the caller passes `now`, so it is unit tested without a DOM.
 */
export interface HlsStallWindow {
  /** Stall episodes that STARTED in this window. */
  stalls: number;
  /** Milliseconds frozen inside this window, including an episode still running. */
  stalledMs: number;
  /** hls.js seek-over-hole skips in this window (the other kind of "stall"). */
  holeSkips: number;
  /** Milliseconds this window covers (since the previous `take`). */
  windowMs: number;
  /** True while any part of this window was spent hidden (`visibilityState`). */
  hidden: boolean;
}

export class HlsStallMeter {
  private stalledSince: number | null = null;
  private stalls = 0;
  private stalledMs = 0;
  private holeSkips = 0;
  private windowStart: number;
  private hiddenInWindow = false;
  private hiddenNow = false;

  constructor(now: number, hidden = false) {
    this.windowStart = now;
    this.hiddenNow = hidden;
    this.hiddenInWindow = hidden;
  }

  /** A `waiting` on the element. Returns true when it opens a new episode. */
  onWaiting(now: number): boolean {
    if (this.stalledSince !== null) {
      return false;
    }
    this.stalledSince = now;
    this.stalls += 1;
    return true;
  }

  /** `playing` (or anything else that proves frames are moving again). */
  onPlaying(now: number): void {
    if (this.stalledSince === null) {
      return;
    }
    this.stalledMs += Math.max(0, now - this.stalledSince);
    this.stalledSince = null;
  }

  onHoleSkip(): void {
    this.holeSkips += 1;
  }

  onVisibility(hidden: boolean): void {
    this.hiddenNow = hidden;
    if (hidden) {
      this.hiddenInWindow = true;
    }
  }

  get isStalled(): boolean {
    return this.stalledSince !== null;
  }

  /** Close the current window and start the next one at `now`. */
  take(now: number): HlsStallWindow {
    let stalledMs = this.stalledMs;
    if (this.stalledSince !== null) {
      stalledMs += Math.max(0, now - this.stalledSince);
      // The episode goes on; only its elapsed part belongs to this window.
      this.stalledSince = now;
    }
    const window: HlsStallWindow = {
      stalls: this.stalls,
      stalledMs: Math.round(stalledMs),
      holeSkips: this.holeSkips,
      windowMs: Math.max(0, Math.round(now - this.windowStart)),
      hidden: this.hiddenInWindow,
    };
    this.stalls = 0;
    this.stalledMs = 0;
    this.holeSkips = 0;
    this.windowStart = now;
    this.hiddenInWindow = this.hiddenNow;
    return window;
  }
}

/**
 * Whether a sample taken at `now` belongs to the attach's startup: before the
 * first frame, or within `startupMs` of it. `firstFrameAt` null = no frame yet.
 */
export function isHlsStartupSample(
  firstFrameAt: number | null,
  now: number,
  startupMs: number,
): boolean {
  return firstFrameAt === null || now - firstFrameAt < startupMs;
}

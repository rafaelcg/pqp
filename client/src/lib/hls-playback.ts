import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/utils";

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
 * Whether a URL hls.js is about to fetch is our own signed playlist proxy --
 * the one request in the whole HLS pipeline that needs a Bearer header. Every
 * segment/media URL the proxy hands back is already an absolute, presigned
 * bucket URL and must NOT get our Authorization header attached: that would
 * leak a user's Clerk-derived token to a third-party origin (R2) and, for a
 * SigV4-signed request, would not even be the right kind of credential.
 */
export function isOwnHlsPlaylistProxyUrl(url: string): boolean {
  return url.startsWith(`${getApiBaseUrl()}${HLS_PLAYLIST_PROXY_PATH}`);
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

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

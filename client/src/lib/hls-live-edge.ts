/**
 * Pure helpers for the watch player's "how far behind live" state, Media
 * Session metadata, Picture-in-Picture availability, and the live-window
 * numbers hls.js is started with. Kept apart from `hls-watch-player.tsx`
 * so they can be unit tested without a DOM.
 */

/**
 * The live window the playlist proxy serves: fifteen 2 s segments = 30 s
 * (`server/src/voice/hls-live-window.ts`). The egress itself writes only
 * five, and an API that predates the widening still serves those 10 s.
 *
 * THE NUMBERS BELOW ARE THE FIX FOR "CHOPPY, THEN STALLS". The old pair
 * (`liveSyncDurationCount: 4`, `liveMaxLatencyDurationCount: 5`) put the
 * playhead 8 s behind the edge of a 10 s window: one segment of slack.
 * Measured on a clean link on 2026-09-12, the window slid past the segment
 * the player wanted next eight times in two minutes, each a hole in the
 * buffer, a forced seek, or a stall with the buffer at zero. Sitting 6 s
 * back with 16 s of tolerance leaves ten segments of listed media behind
 * the playhead on the widened window, and still two on the old one.
 */
export const HLS_LIVE_SEGMENT_SECONDS = 2;
export const HLS_LIVE_WINDOW_SECONDS = 30;
/** ~6 s behind live: three segments, the hls.js default for a reason. */
export const HLS_LIVE_SYNC_DURATION_COUNT = 3;
/**
 * Skip forward only once the playhead is 16 s behind. Must be greater
 * than the sync count and fit the window; against an older API's 10 s
 * window hls.js simply re-syncs when the playlist no longer lists the
 * playhead, which is what it did before and no worse.
 */
export const HLS_LIVE_MAX_LATENCY_DURATION_COUNT = 8;
/** Buffer up to 12 s ahead; never more than 20, well inside the window. */
export const HLS_MAX_BUFFER_LENGTH_SECONDS = 12;
export const HLS_MAX_MAX_BUFFER_LENGTH_SECONDS = 20;
/**
 * hls.js defaults `backBufferLength` to `Infinity`, which keeps every
 * appended segment in the SourceBuffer for the whole party. Ten seconds
 * behind the playhead is all a seek back to live ever needs.
 */
export const HLS_BACK_BUFFER_LENGTH_SECONDS = 10;

export interface HlsLivePlayerConfig {
  liveSyncDurationCount: number;
  liveMaxLatencyDurationCount: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  backBufferLength: number;
  /** Auto: ABR picks from the seed, which is the 720p60@3200 rung. */
  startLevel: number;
}

export function hlsLivePlayerConfig(): HlsLivePlayerConfig {
  return {
    liveSyncDurationCount: HLS_LIVE_SYNC_DURATION_COUNT,
    liveMaxLatencyDurationCount: HLS_LIVE_MAX_LATENCY_DURATION_COUNT,
    maxBufferLength: HLS_MAX_BUFFER_LENGTH_SECONDS,
    maxMaxBufferLength: HLS_MAX_MAX_BUFFER_LENGTH_SECONDS,
    backBufferLength: HLS_BACK_BUFFER_LENGTH_SECONDS,
    startLevel: -1,
  };
}

/** hls.js ABR seed: above the 720 peak so Auto does not start on 480p. */
export const HLS_ABR_DEFAULT_ESTIMATE_BPS = 3_500_000;

/**
 * Where "jump to live" should land. Seeking onto the exact live edge
 * sits inside the newest segment and often `waiting` immediately.
 */
export function jumpToLiveTime(
  liveSyncPosition: number,
  segmentSeconds: number = HLS_LIVE_SEGMENT_SECONDS,
): number {
  if (!Number.isFinite(liveSyncPosition)) {
    return liveSyncPosition;
  }
  return Math.max(0, liveSyncPosition - segmentSeconds);
}

/**
 * The real live edge, not a leftover `liveSyncPosition` from a short window.
 *
 * THE BUG THIS EXISTS FOR. Recover / jump-to-live used
 * `hls.liveSyncPosition ?? video.duration`. After `startLoad()` the sync
 * point can be the first-window value (~6–8 s) while the media element's
 * timeline has already grown with the session. Seeking there jumps the
 * picture back about a minute of already-buffered media and keeps playing
 * — no stall, just the wrong part of the film. Prefer the larger of the
 * two finite clocks; that is the actual edge.
 */
export function resolveLiveEdge(
  liveSyncPosition: number | null | undefined,
  seekableEnd: number,
): number | null {
  const candidates = [liveSyncPosition, seekableEnd].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (candidates.length === 0) {
    return null;
  }
  return Math.max(...candidates);
}

/** Last end of `video.seekable`. Empty range is not a live edge. */
export function mediaSeekableEnd(video: {
  seekable: { length: number; end: (index: number) => number };
}): number {
  const { seekable } = video;
  if (seekable.length === 0) {
    return Number.NaN;
  }
  return seekable.end(seekable.length - 1);
}

/**
 * Where a recover / jump-to-live seek may move the playhead.
 *
 * Returns null instead of a target more than one live window behind the
 * current playhead: that seek is not "catch up", it is the Chrome content
 * swap (old media still sitting in an infinite back-buffer).
 */
export function liveSeekTarget(input: {
  currentTime: number;
  liveSyncPosition: number | null | undefined;
  seekableEnd: number;
}): number | null {
  const edge = resolveLiveEdge(input.liveSyncPosition, input.seekableEnd);
  if (edge === null) {
    return null;
  }
  const target = jumpToLiveTime(edge);
  if (
    Number.isFinite(input.currentTime) &&
    input.currentTime - target > HLS_LIVE_WINDOW_SECONDS
  ) {
    return null;
  }
  return target;
}

/**
 * True when a live-sync / max-latency pair still sits inside the production
 * window. The attach path must not start so far from the edge that the
 * playhead falls out the back on the next playlist update.
 */
export function hlsLiveSyncFitsWindow(config: HlsLivePlayerConfig): boolean {
  const sync = config.liveSyncDurationCount * HLS_LIVE_SEGMENT_SECONDS;
  const maxLatency =
    config.liveMaxLatencyDurationCount * HLS_LIVE_SEGMENT_SECONDS;
  return (
    sync < HLS_LIVE_WINDOW_SECONDS &&
    maxLatency <= HLS_LIVE_WINDOW_SECONDS &&
    maxLatency > sync &&
    config.maxBufferLength <= HLS_LIVE_WINDOW_SECONDS &&
    config.maxMaxBufferLength <= HLS_LIVE_WINDOW_SECONDS &&
    Number.isFinite(config.backBufferLength) &&
    config.backBufferLength <= HLS_LIVE_WINDOW_SECONDS
  );
}

/** How far behind hls.js's live edge the playhead currently sits. */
export function secondsBehindLive(
  currentTime: number,
  liveEdge: number,
): number {
  return Math.max(0, liveEdge - currentTime);
}

/**
 * The "Ao vivo" badge turns into a "Pular pro ao vivo" button once the
 * playhead drifts more than this far behind hls.js's live edge. 10s is
 * roughly the egress delay itself, so this only fires on top of the delay
 * that is already the product (buffering, a paused tab catching up, a
 * throttled background tab), not on the delay everyone always has.
 */
export const BEHIND_LIVE_THRESHOLD_SECONDS = 10;

export function isBehindLive(
  currentTime: number,
  liveEdge: number,
  threshold: number = BEHIND_LIVE_THRESHOLD_SECONDS,
): boolean {
  return secondsBehindLive(currentTime, liveEdge) > threshold;
}

export interface MediaSessionMetadataInput {
  /** The party or presenter's title. Falls back to the channel name. */
  title: string;
  /** Community or server name, shown as the artist/album line. */
  communityName?: string | null;
  /** Server icon, used when no dedicated cover exists for the stream. */
  coverUrl?: string | null;
}

export interface BuiltMediaSessionMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string; type?: string }[];
}

/**
 * What goes on the lock screen. Without this the OS falls back to the page
 * title, which for pqp is the deploy URL
 * (`staging.pqp-3yr.pages.dev`), not the party anyone actually joined.
 */
export function buildMediaSessionMetadata(
  input: MediaSessionMetadataInput,
): BuiltMediaSessionMetadata {
  return {
    title: input.title,
    artist: input.communityName ?? "pqp",
    album: input.communityName ?? "pqp",
    artwork: input.coverUrl
      ? [{ src: input.coverUrl, sizes: "512x512" }]
      : [],
  };
}

/**
 * Whether this document/browser can offer Picture-in-Picture for a video
 * element at all. Safari has no `document.pictureInPictureEnabled`; it
 * exposes presentation modes on the element instead, which the caller
 * checks separately (`hasSafariPresentationMode`).
 */
export function isPipAvailable(input: {
  pictureInPictureEnabled: boolean;
  disablePictureInPicture: boolean;
}): boolean {
  return input.pictureInPictureEnabled && !input.disablePictureInPicture;
}

/** Safari's non-standard PiP surface, present when `document.pictureInPictureEnabled` is not. */
export function hasSafariPresentationMode(video: unknown): boolean {
  return (
    typeof video === "object" &&
    video !== null &&
    "webkitSupportsPresentationMode" in video &&
    typeof (video as { webkitSupportsPresentationMode: unknown })
      .webkitSupportsPresentationMode === "function" &&
    (
      video as { webkitSupportsPresentationMode: (mode: string) => boolean }
    ).webkitSupportsPresentationMode("picture-in-picture")
  );
}

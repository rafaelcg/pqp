/**
 * Pure helpers for the watch player's "how far behind live" state, Media
 * Session metadata, Picture-in-Picture availability, and the live-window
 * numbers hls.js is started with. Kept apart from `hls-watch-player.tsx`
 * so they can be unit tested without a DOM.
 */

/**
 * Production live window is about five 2 s segments = 10 s of playlist.
 *
 * `liveSyncDurationCount: 3` was ~6 s behind the live edge. That is a
 * reasonable place to sit, but it left only ~4 s of already-listed
 * segments in front of the playhead, and a brief stall dropped the
 * playhead out of the window. These numbers keep the start a little
 * further back (more forward buffer) without joining so far from the
 * edge that the next playlist update expires the segment we are on.
 */
export const HLS_LIVE_SEGMENT_SECONDS = 2;
export const HLS_LIVE_WINDOW_SECONDS = 10;
/** ~8 s behind live: two more seconds of listed segments than the old 3. */
export const HLS_LIVE_SYNC_DURATION_COUNT = 4;
/**
 * Skip forward once latency reaches the window itself. Must be greater
 * than the sync count; 5 × 2 s = 10 s, which still fits.
 */
export const HLS_LIVE_MAX_LATENCY_DURATION_COUNT = 5;
/** Fill most of the 10 s window; do not ask hls.js for a 30 s buffer it cannot have. */
export const HLS_MAX_BUFFER_LENGTH_SECONDS = 8;
export const HLS_MAX_MAX_BUFFER_LENGTH_SECONDS = 10;

export interface HlsLivePlayerConfig {
  liveSyncDurationCount: number;
  liveMaxLatencyDurationCount: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
}

export function hlsLivePlayerConfig(): HlsLivePlayerConfig {
  return {
    liveSyncDurationCount: HLS_LIVE_SYNC_DURATION_COUNT,
    liveMaxLatencyDurationCount: HLS_LIVE_MAX_LATENCY_DURATION_COUNT,
    maxBufferLength: HLS_MAX_BUFFER_LENGTH_SECONDS,
    maxMaxBufferLength: HLS_MAX_MAX_BUFFER_LENGTH_SECONDS,
  };
}

/** hls.js ABR seed: the 720p30 average, not the library's 500 kbit/s floor. */
export const HLS_ABR_DEFAULT_ESTIMATE_BPS = 1_800_000;

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
    config.maxMaxBufferLength <= HLS_LIVE_WINDOW_SECONDS
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

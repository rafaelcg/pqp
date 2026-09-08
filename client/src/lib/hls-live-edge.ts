/**
 * Pure helpers for the watch player's "how far behind live" state, Media
 * Session metadata, and Picture-in-Picture availability. Kept apart from
 * `hls-watch-player.tsx` so they can be unit tested without a DOM.
 */

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

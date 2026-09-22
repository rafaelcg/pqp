import type { MusicResolved } from "@pqp/shared";
import { relatedMusic } from "@/lib/api";

/**
 * The one fetcher every autoplay path hands to the store.
 *
 * The store takes it as an argument rather than importing it, so its tests
 * can answer without a network; this is the answer everything in the app
 * gives. It was written out inline at each call site until the skip button
 * needed one too.
 */
export async function musicRelatedTracks(
  videoId: string,
): Promise<MusicResolved[]> {
  const { tracks } = await relatedMusic(videoId);
  return tracks;
}

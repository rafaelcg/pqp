import type { PublicJamSong } from "@pqp/shared";

/**
 * The home's featured slot over a page in Em alta order: the first song with a
 * part to show whose `artist` is null (an original), else the first song with a
 * part. The showcase should never be a cover of somebody else's hit when an
 * original is on the page.
 */
export function pickFeatured<T extends Pick<PublicJamSong, "parts" | "artist">>(songs: readonly T[]): T | null {
  const playable = songs.filter((candidate) => candidate.parts.length > 0);
  return playable.find((candidate) => candidate.artist === null) ?? playable[0] ?? null;
}

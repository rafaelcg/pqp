import type { PublicJamSong } from "@pqp/shared";

/**
 * Whether a song takes a part from a visitor: anything but `closed` (only the
 * starter adds there). An absent `joinMode`, a payload from a server older than
 * the field, reads as open, which is what every client assumed before.
 */
export function takesParts(song: Pick<PublicJamSong, "joinMode">): boolean {
  return song.joinMode !== "closed";
}

/**
 * The home's featured slot over a page in Em alta order, among the songs with
 * a part to show: the first original (`artist` null) that takes a part, else
 * the first original, else the first song that takes a part, else the first
 * song. The showcase should not be somebody else's hit when an original is on
 * the page, and the button under it should lead somewhere: a visitor who
 * signs up to record on a closed song meets "Essa música tá fechada" in the
 * app (user test round 1, B2). A closed original still beats an open cover,
 * because a cover as the showcase is the rights risk; its page says plainly
 * that it takes no part and offers to start one.
 */
export function pickFeatured<T extends Pick<PublicJamSong, "parts" | "artist" | "joinMode">>(songs: readonly T[]): T | null {
  const playable = songs.filter((candidate) => candidate.parts.length > 0);
  const original = (candidate: T) => candidate.artist === null;
  return (
    playable.find((candidate) => original(candidate) && takesParts(candidate)) ??
    playable.find(original) ??
    playable.find(takesParts) ??
    playable[0] ??
    null
  );
}

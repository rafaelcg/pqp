import { musicResolvedSchema, type MusicResolved } from "@pqp/shared";

/**
 * WHAT THIS PERSON PICKED LATELY, ON THIS DEVICE.
 *
 * The room's own history (`state.history`) lives only as long as the room, so
 * a call that has just started has nothing to offer. These are the last songs
 * this person added from the stage search, kept in the browser, so an empty
 * Rádio opens on something to tap instead of a blank stage. Nothing leaves the
 * device; storage that throws (a private window) just means no list.
 */

const KEY = "pqp:music-recent";
export const MUSIC_RECENT_LIMIT = 8;

export function readMusicRecent(): MusicResolved[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => musicResolvedSchema.safeParse(entry))
      .flatMap((result) => (result.success ? [result.data] : []))
      .slice(0, MUSIC_RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Newest first, one row per video. */
export function rememberMusicRecent(tracks: readonly MusicResolved[]): void {
  if (tracks.length === 0) {
    return;
  }
  const incoming = new Set(tracks.map((track) => track.videoId));
  const next = [
    ...tracks,
    ...readMusicRecent().filter((track) => !incoming.has(track.videoId)),
  ].slice(0, MUSIC_RECENT_LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // No storage, no list.
  }
}

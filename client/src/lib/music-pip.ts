import { isHintSeen, rememberHint, shouldPersistHints } from "./hints";

/**
 * NOVO ON THE CALL DOCK'S MÚSICA TILE.
 *
 * A pip, not a card: it is outside `CORNER_HINT_ORDER` and outside the
 * attached queue, so it arbitrates with nothing and can sit beside a hint
 * that won the slot for something else.
 *
 * It keeps a key of its own rather than reading the music hint's. The card
 * records its impression on first paint and its gate is a superset of this
 * one, so a shared key would be stamped in the frame the pip first drew,
 * and a mark meant to survive until somebody opens the panel would last
 * one render. This key is spent by opening the panel, which is the only
 * thing that proves the tile was found.
 */
export const MUSIC_PIP_KEY = "pqp:music-pip-2026-09";

export function isMusicPipSeen(
  storage?: Pick<Storage, "getItem"> | null,
  persist: boolean = shouldPersistHints(),
): boolean {
  return isHintSeen(MUSIC_PIP_KEY, storage, persist);
}

export function rememberMusicPip(
  storage?: Pick<Storage, "setItem"> | null,
  persist: boolean = shouldPersistHints(),
): void {
  rememberHint(MUSIC_PIP_KEY, storage, persist);
}

/**
 * SPEAK for the same reason the card asks for it: without it the tile opens
 * a panel this person may only read. A track already on makes the bar the
 * announcement, so the pip has nothing left to say.
 */
export function shouldShowMusicPip(input: {
  seen: boolean;
  automated: boolean;
  canSpeak: boolean;
  playing: boolean;
}): boolean {
  return !input.seen && !input.automated && input.canSpeak && !input.playing;
}

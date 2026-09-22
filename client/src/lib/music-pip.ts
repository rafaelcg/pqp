import { useSyncExternalStore } from "react";
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

/**
 * SPENT IS A FACT THE WHOLE APP SHARES, SO IT IS A STORE AND NOT A READ.
 *
 * The pip is drawn on the dock tile, and the panel that spends it can be
 * opened from three other places: the sidebar radio's start button, the
 * bar's queue icon, the tile itself. The tile used to read storage once at
 * mount, so a stamp written anywhere else did not reach it and the person
 * who had plainly found the feature was still being told it was new.
 *
 * `null` means nobody has asked yet; the first read answers from storage
 * and the answer is kept, because the only thing that changes it is this
 * module.
 */
let spent: boolean | null = null;
const listeners = new Set<() => void>();

export function subscribeMusicPip(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function musicPipSpent(): boolean {
  if (spent === null) {
    spent = isMusicPipSeen();
  }
  return spent;
}

export function useMusicPipSpent(): boolean {
  return useSyncExternalStore(subscribeMusicPip, musicPipSpent, musicPipSpent);
}

/**
 * Starts unspent by default. `null` would mean "ask storage", and a Node
 * test has no storage at all, which `lib/hints.ts` deliberately reads as
 * "already seen" so a card cannot loop in a private tab.
 */
export function resetMusicPipForTests(next: boolean | null = false): void {
  spent = next;
  listeners.clear();
}

export function rememberMusicPip(
  storage?: Pick<Storage, "setItem"> | null,
  persist: boolean = shouldPersistHints(),
): void {
  rememberHint(MUSIC_PIP_KEY, storage, persist);
  if (musicPipSpent()) {
    return;
  }
  spent = true;
  for (const listener of listeners) {
    listener();
  }
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

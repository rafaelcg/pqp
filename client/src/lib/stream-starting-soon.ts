import { useEffect, useState } from "react";

/**
 * The "stream starting soon" holding screen: a looping bubble film behind a
 * headline that rotates through a small set of playful lines. This module is
 * the part with no DOM in it, so the timing can be pinned with fake timers
 * (`use-idle-chrome.ts` is the same split: a plain controller, and a thin
 * React binding at the bottom of the file).
 */

/** How long each line stays up before the next one crossfades in. */
export const STARTING_SOON_LINE_INTERVAL_MS = 6_000;

/** How long the crossfade itself takes. Matches the overlay's own fade. */
export const STARTING_SOON_CROSSFADE_MS = 700;

/**
 * i18n keys for the rotating lines, in order. `voice.watchParty.startingSoon`
 * is the namespace; see `docs/I18N.md`. Kept short (≈40 chars) so every line
 * fits a phone-width tile without wrapping onto a third line.
 */
export const STARTING_SOON_LINE_KEYS = [
  "voice.watchParty.startingSoon.line1",
  "voice.watchParty.startingSoon.line2",
  "voice.watchParty.startingSoon.line3",
  "voice.watchParty.startingSoon.line4",
  "voice.watchParty.startingSoon.line5",
  "voice.watchParty.startingSoon.line6",
  "voice.watchParty.startingSoon.line7",
] as const;

export interface LineRotatorController {
  /** The line currently on screen. */
  readonly index: number;
  dispose(): void;
}

/**
 * Advances `index` through `[0, lineCount)` on a fixed interval, wrapping
 * around. A single line (or none) never starts a timer: nothing to rotate
 * to, so nothing should ever re-render.
 */
export function createLineRotator(
  lineCount: number,
  onChange: (index: number) => void,
  intervalMs: number = STARTING_SOON_LINE_INTERVAL_MS,
): LineRotatorController {
  let index = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (lineCount > 1) {
    timer = setInterval(() => {
      index = (index + 1) % lineCount;
      onChange(index);
    }, intervalMs);
  }
  return {
    get index() {
      return index;
    },
    dispose() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * React binding for `createLineRotator`. One `setInterval` per mount, torn
 * down on unmount or when `lineCount`/`intervalMs` change.
 */
export function useRotatingLineIndex(
  lineCount: number,
  intervalMs: number = STARTING_SOON_LINE_INTERVAL_MS,
): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (lineCount <= 1) {
      setIndex(0);
      return;
    }
    const controller = createLineRotator(lineCount, setIndex, intervalMs);
    return () => controller.dispose();
  }, [lineCount, intervalMs]);
  return index;
}

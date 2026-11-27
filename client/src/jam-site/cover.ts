import { useEffect, useSyncExternalStore } from "react";
import type { PublicPlayer } from "./player";

/**
 * Is something covering the page? A sheet or a dialog, one that takes the
 * screen and wants a decision (the account sheet, the report sheet).
 *
 * User test round 1 (m9), still open in round 3: the song kept playing behind
 * the account sheet, so a person reading "para gravar, entra no pqp" had the
 * band in their ears at volume and nothing to do with it. Whatever covers the
 * page registers here (`Sheet` in `ui.tsx` does it for every sheet the site
 * has), and the player of the page underneath pauses (`usePauseWhenCovered`).
 *
 * It only pauses. It never resumes: playing is a press the person makes, and
 * an audio start with nobody's finger on it is what round 2 (m8) took out.
 */

let covers = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Something now covers the page. Call the returned function when it stops. */
export function coverPage(): () => void {
  covers += 1;
  emit();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    covers -= 1;
    emit();
  };
}

export function isPageCovered(): boolean {
  return covers > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCovered(): boolean {
  return useSyncExternalStore(subscribe, isPageCovered, () => false);
}

/**
 * Pause the player the moment something covers the page, and only then: a song
 * that is already paused stays so, and uncovering resumes nothing.
 */
export function usePauseWhenCovered(player: Pick<PublicPlayer, "getState" | "toggle">): void {
  const covered = useCovered();
  useEffect(() => {
    if (covered && player.getState().playing) {
      player.toggle();
    }
  }, [covered, player]);
}

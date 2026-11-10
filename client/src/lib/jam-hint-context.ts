import { useSyncExternalStore } from "react";

/**
 * Which jam screen is on, for the first-run hint queue in `App`.
 *
 * The coach marks are drawn by the screens that own the control they point at,
 * but WHICH one may draw is decided once, in `App`, through
 * `lib/feature-hints.ts` (one attached hint at a time, nothing over a call).
 * `App` cannot see inside the jam pane, so the pane and the studio say here
 * that they are on screen, and `App` reads it when it builds the "wanting" map.
 */

export interface JamHintContext {
  wall: boolean;
  studio: boolean;
}

let current: JamHintContext = { wall: false, studio: false };
const listeners = new Set<() => void>();

export function setJamHintContext(patch: Partial<JamHintContext>): void {
  const next = { ...current, ...patch };
  if (next.wall === current.wall && next.studio === current.studio) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

export function useJamHintContext(): JamHintContext {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
    () => current,
  );
}

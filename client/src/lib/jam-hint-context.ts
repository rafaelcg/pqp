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
  /** A song is open (its panel is on screen, in a channel's wall or as a public view): its transport and record button are in play. */
  song: boolean;
  /**
   * A Jam notice (a part arrived, a part was answered, the starter's toast) is drawn over the app
   * right now. The corner queue yields while it is: one thing at a time asking for the person's
   * eyes, and the notice is the one they are waiting for (round 3, N-1).
   */
  notice: boolean;
}

let current: JamHintContext = { wall: false, studio: false, song: false, notice: false };
const listeners = new Set<() => void>();

export function setJamHintContext(patch: Partial<JamHintContext>): void {
  const next = { ...current, ...patch };
  if (next.wall === current.wall && next.studio === current.studio && next.song === current.song && next.notice === current.notice) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

let songPanels = 0;

/**
 * A song's panel is open. A counter, not a flag: a public view can open over a channel's own song
 * (two panels at once), and the second one closing must not say "no song is open" while the first
 * still is, or a notice would be drawn over its controls (Farol, PR 1778). Returns the release.
 */
export function holdJamSong(): () => void {
  songPanels += 1;
  setJamHintContext({ song: true });
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    songPanels -= 1;
    setJamHintContext({ song: songPanels > 0 });
  };
}

/** Is any song panel open right now. */
export function isJamSongOpen(): boolean {
  return current.song;
}

/** Is the studio on screen right now (for code that must not stop the band under a recording). */
export function isJamStudioOpen(): boolean {
  return current.studio;
}

/** Is the Jam's wall on screen right now (it owns the shared engine while it is). */
export function isJamWallOpen(): boolean {
  return current.wall;
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

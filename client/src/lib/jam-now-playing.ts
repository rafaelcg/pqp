import { useSyncExternalStore } from "react";

/**
 * Whether this client is playing a Jam song right now, for the sidebar row.
 *
 * The one audio engine (`jam-session.ts`) already knows: its player emits on
 * every transport change. This is the one place that listens, so the row needs
 * no frame, no request and no change to the screens that drive the player.
 * The engine is released when the person leaves the Jam, and that clears it.
 */

interface PlayerLike {
  subscribe(listener: (tick: { state: string }) => void): () => void;
}

let playing = false;
let detach: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (playing === next) {
    return;
  }
  playing = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Start following an engine's player (replacing the one before it). */
export function followJamPlayer(player: PlayerLike): void {
  detach?.();
  // The player calls back on every animation frame while playing; the store
  // only reacts to the boolean changing, so a frame costs one comparison.
  detach = player.subscribe((tick) => set(tick.state === "playing"));
}

/** The engine is gone: nothing is playing. */
export function forgetJamPlayer(): void {
  detach?.();
  detach = null;
  set(false);
}

export function isJamPlaying(): boolean {
  return playing;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useJamPlaying(): boolean {
  return useSyncExternalStore(subscribe, isJamPlaying, () => false);
}

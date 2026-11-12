import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PlayerState, PublicPlayer } from "./player";

/** The player's state, re-rendering the caller only when it changes (not per frame). */
export function usePlayerState(player: PublicPlayer): PlayerState {
  const subscribe = useCallback((listener: () => void) => player.subscribe(listener), [player]);
  return useSyncExternalStore(subscribe, player.getState, player.getState);
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Call `draw` whenever the clock moves: every animation frame while the song
 * plays (a few times a second under reduced motion), and once on every change
 * of the player (a seek, a pause, a solo) while it does not. `draw` writes to
 * the DOM; it must not set React state per frame.
 */
export function useClockDraw(player: PublicPlayer, playing: boolean, draw: () => void): void {
  useEffect(() => {
    draw();
    const off = player.subscribe(draw);
    let raf = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    if (playing) {
      if (prefersReducedMotion()) {
        timer = setInterval(draw, 250);
      } else {
        const loop = () => {
          draw();
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      }
    }
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
    };
  }, [player, playing, draw]);
}

/** A CSS media query, as a boolean. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let list: MediaQueryList;
    try {
      list = window.matchMedia(query);
    } catch {
      return;
    }
    const on = () => setMatches(list.matches);
    on();
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, [query]);
  return matches;
}

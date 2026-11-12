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

/**
 * The width over height a wide mosaic should have so that the stage AND the
 * player under it fit on the first screen: as wide as the column, as tall as the
 * window leaves after the header, the title and the controls (about 19 rem).
 * Never narrower than 16:9; the mosaic clamps it at the other end.
 */
export function stageAspect(): number {
  const width = Math.min(1152, window.innerWidth - 64);
  const height = Math.max(300, window.innerHeight - 304);
  return Math.min(2.1, Math.max(16 / 9, width / height));
}

export function useStageAspect(): number {
  const [aspect, setAspect] = useState(() => {
    try {
      return stageAspect();
    } catch {
      return 16 / 9;
    }
  });
  useEffect(() => {
    const on = () => setAspect(stageAspect());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return aspect;
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

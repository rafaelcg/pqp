import { useSyncExternalStore } from "react";
import { LG_UP_QUERY } from "@/lib/breakpoints";

/**
 * Tailwind's `lg` breakpoint. Must stay in lockstep with `lg:` utilities:
 * the two-share split is mounted only when this matches, so a CSS hide cannot
 * leave a second live `<video>` decoding in the background.
 */
export const LG_QUERY = LG_UP_QUERY;

function query(): MediaQueryList | null {
  try {
    return window.matchMedia(LG_QUERY);
  } catch {
    // Older WebViews and non-browser renderers have no matchMedia at all.
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  if (!list) {
    return () => {};
  }
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return query()?.matches ?? false;
}

/**
 * Whether the window is `lg` or wider. False when matchMedia is missing, which
 * is the phone layout: one picture plus chips, never a hidden split grid.
 */
export function useLgUp(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

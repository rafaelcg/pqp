import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function query(): MediaQueryList | null {
  try {
    return window.matchMedia(QUERY);
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
 * Whether the reader has asked the OS to cut down on animation. Autoplaying
 * GIFs are exactly what that setting is for, so a message with one shows its
 * still frame until it is clicked.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

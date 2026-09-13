import { useSyncExternalStore } from "react";

/**
 * Tailwind's `sm` breakpoint (640px) — the line `docs/ONBOARDING.md` draws
 * for the Voz limpa nudge: below it the card never shows, and the NOVO dot
 * on the Settings row is the only discoverability a phone gets.
 */
export const SM_QUERY = "(min-width: 40rem)";

function query(): MediaQueryList | null {
  try {
    return window.matchMedia(SM_QUERY);
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
 * Whether the window is `sm` or wider. False without `matchMedia`, which
 * reads as "treat this as a phone" — the safer default for a card that must
 * not show on one.
 */
export function useSmUp(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

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

/**
 * `MediaQueryList` older than the 2020 dpub spec — old Safari, plenty of
 * embedded WebViews — has `matchMedia` but only the pre-standard
 * `addListener`/`removeListener` pair, not `addEventListener`. Calling the
 * modern method there throws (not "does nothing"), so `useSmUp` would crash
 * the whole app on mount rather than just fail to react to a resize.
 */
interface LegacyMediaQueryList {
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  if (!list) {
    return () => {};
  }
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }
  const legacy = list as unknown as LegacyMediaQueryList;
  if (typeof legacy.addListener === "function") {
    legacy.addListener(onChange);
    return () => legacy.removeListener(onChange);
  }
  // Neither API: the snapshot is read once and never updates, which is safe
  // — `getSnapshot` still answers correctly for however the window opened.
  return () => {};
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

import { useSyncExternalStore } from "react";

/**
 * Tailwind's `md` breakpoint, which in this shell is the line between "the
 * channel list is a column" and "the channel list is a drawer over the chat".
 *
 * Must stay in lockstep with the `md:` utilities on the sidebars: the
 * icons-only rail is a column layout only, and asking for it while the list is
 * a drawer would collapse something that is already fully hidden.
 */
export const MD_QUERY = "(min-width: 48rem)";

function query(): MediaQueryList | null {
  try {
    return window.matchMedia(MD_QUERY);
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
 * Whether the window is `md` or wider. False without `matchMedia`, which is
 * the drawer layout — the one where every sidebar control still works.
 */
export function useMdUp(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

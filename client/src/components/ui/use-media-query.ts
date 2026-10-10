import { useEffect, useState } from "react";

function matches(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return fallback;
  }
  return window.matchMedia(query).matches;
}

/**
 * Whether a media query matches now, kept in step as it changes. Without
 * `matchMedia` (jsdom, a very old webview) it answers `fallback`, so a test
 * renders the layout the caller considers the safe default.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const [value, setValue] = useState(() => matches(query, fallback));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const list = window.matchMedia(query);
    const sync = () => setValue(list.matches);
    sync();
    list.addEventListener?.("change", sync);
    return () => list.removeEventListener?.("change", sync);
  }, [query]);
  return value;
}

/** Tailwind's `sm`: the rail is a vertical column from here up. */
export const SM_UP_QUERY = "(min-width: 640px)";

/**
 * A device with a touch screen and no mouse or trackpad anywhere. A tablet
 * with a trackpad attached reports a fine pointer and does not count. A
 * hardware keyboard cannot be detected, so this is the closest honest proxy
 * for "keyboard shortcuts do nothing here". Two queries rather than one with
 * `not (...)` inside it, which older Safari does not parse. Without
 * `matchMedia` it answers false: show everything.
 */
export function useTouchOnly(): boolean {
  const fine = useMediaQuery("(any-pointer: fine)", true);
  const coarse = useMediaQuery("(any-pointer: coarse)", false);
  return coarse && !fine;
}

import { useSyncExternalStore } from "react";

/**
 * Light and dark for the public site. It shares the app's storage key
 * (`pqp-theme`) so a choice made in one is kept in the other on the same
 * origin, but it reads it itself: `@/lib/theme` reaches into the desktop shell
 * and the preference sync, none of which a public page has.
 *
 * Dark first: with no stored choice the site is dark, which is what it was
 * designed in. The boot script in `jam-site/index.html` applies the same rule
 * before the first paint, so there is no flash.
 */
const KEY = "pqp-theme";

export type Brightness = "light" | "dark";

function stored(): "light" | "dark" | "system" | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" || value === "system" ? value : null;
  } catch {
    return null;
  }
}

export function resolveBrightness(): Brightness {
  const choice = stored();
  if (choice === "light" || choice === "dark") {
    return choice;
  }
  if (choice === "system") {
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      return "dark";
    }
  }
  return "dark";
}

const listeners = new Set<() => void>();

export function setBrightness(next: Brightness): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // The page still themes; the choice is just not kept.
  }
  document.documentElement.dataset.theme = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBrightness(): Brightness {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    () => "dark" as const,
  );
}

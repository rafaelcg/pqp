/**
 * Theme preference and the DOM attribute the stylesheet keys off.
 *
 * The preference gets its own storage key instead of joining the
 * `pqp-local-settings` blob: the boot script in `index.html` has to resolve the
 * theme before the bundle loads, and parsing an audio-settings object there
 * would be both slower and one more thing that can throw before first paint.
 */

import type { ThemePreference } from "@pqp/shared";
import {
  appearanceForcesDark as isNightLook,
  getAppearance,
  subscribeAppearance,
} from "@/lib/appearance";
import { getDesktop } from "@/lib/desktop";
import { queuePreferenceSync } from "@/lib/preferences";

// Re-exported from the shared package so the union the boot script, the radio
// group and the server's validator all key off cannot drift apart.
export type { ThemePreference };
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "pqp-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

function isPreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function readStoredTheme(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(raw) ? raw : null;
  } catch {
    // Safari private mode throws on storage access; treat it as "no choice yet".
    return null;
  }
}

export function storeTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Persistence is a convenience — the session still themes correctly.
  }
}

/** The `prefers-color-scheme` list, or null where matchMedia is unavailable. */
export function prefersDarkQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(DARK_QUERY);
  } catch {
    return null;
  }
}

export function systemTheme(): ResolvedTheme {
  const query = prefersDarkQuery();
  // Dark is the fallback: it is what the app looked like before it had themes.
  if (query === null) {
    return "dark";
  }
  return query.matches ? "dark" : "light";
}

function appearanceForcesDark(): boolean {
  return isNightLook(getAppearance());
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  // Night is a near-black look. Light Night is a contradiction, so brightness
  // stays dark for as long as that skin is the one on the document.
  if (appearanceForcesDark()) {
    return "dark";
  }
  return preference === "system" ? systemTheme() : preference;
}

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

/*
 * A module-level store rather than per-hook state: the settings modal, the
 * Clerk bridge and the emoji picker all read the theme, and a preference change
 * in one has to reach the others in the same render.
 */
const listeners = new Set<() => void>();

/**
 * Routes that are compositions over a hero photograph pin themselves to dark
 * while mounted, so `resolved` is what the document actually shows — an OS
 * switch behind a pinned route must not repaint it, and anything reading the
 * theme to match it (Clerk's modal, the emoji picker) has to agree with the page
 * rather than with the stored preference.
 */
let forced: ResolvedTheme | null = null;

const initialPreference = readStoredTheme() ?? "system";
let state: ThemeState = {
  preference: initialPreference,
  resolved: resolveTheme(initialPreference),
};

export function getThemeState(): ThemeState {
  return state;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(preference: ThemePreference): void {
  const resolved = forced ?? resolveTheme(preference);
  if (preference === state.preference && resolved === state.resolved) {
    return;
  }
  state = { preference, resolved };
  applyTheme(resolved);
  // The Electron main process cannot read this tab's localStorage, and it needs
  // the answer before the renderer exists to paint the window background.
  getDesktop()?.setTheme?.(resolved);
  for (const listener of listeners) {
    listener();
  }
}

/** A choice the user just made here: apply it, keep it, and send it on. */
export function setThemePreference(preference: ThemePreference): void {
  const already = preference === state.preference;
  storeTheme(preference);
  commit(preference);
  // Night locks the radios to Dark. Arrow keys would otherwise re-PATCH
  // `{theme:"dark"}` on every press of the only enabled option.
  if (already) {
    return;
  }
  queuePreferenceSync({ theme: preference }, { immediate: true });
}

/**
 * Take the theme the account already carries, as returned by `/api/me`.
 *
 * Deliberately does not sync back. The value came from the server, so writing
 * it again would at best be a no-op and at worst let a tab that has been open
 * since yesterday overwrite the choice the user made on another device since.
 * It is still persisted locally, so the boot script paints this theme rather
 * than the old one on the next load.
 */
export function adoptThemePreference(preference: ThemePreference): void {
  storeTheme(preference);
  commit(preference);
}

/** Re-resolve after the OS scheme changed. No-op unless following the system. */
export function syncSystemTheme(): void {
  if (state.preference !== "system") {
    return;
  }
  commit("system");
}

/** Pin the document to one theme. Returns the restore function. */
export function forceTheme(theme: ResolvedTheme): () => void {
  forced = theme;
  commit(state.preference);
  return () => {
    forced = null;
    commit(state.preference);
  };
}

// The `document` guard is for the node-environment unit tests.
if (typeof document !== "undefined") {
  // Night + a leftover light preference is not a valid UI state. Persist dark
  // locally only: writing the account on boot would let a stale tab clobber.
  if (appearanceForcesDark() && state.preference !== "dark") {
    storeTheme("dark");
    state = { preference: "dark", resolved: "dark" };
  }
  // Only fills in when the boot script did not run — a future CSP without a
  // hash for it would otherwise leave the session on the wrong theme. Writing
  // unconditionally would undo the boot script's dark pin on marketing routes.
  if (!document.documentElement.dataset.theme) {
    applyTheme(state.resolved);
  }
  // `commit` only fires on change, so the desktop shell would otherwise learn
  // the theme only after the user next touched it.
  getDesktop()?.setTheme?.(state.resolved);
  subscribeAppearance(() => {
    if (appearanceForcesDark()) {
      if (state.preference !== "dark") {
        storeTheme("dark");
      }
      commit("dark");
      return;
    }
    commit(state.preference);
  });
}

/**
 * Appearance preference and the DOM attribute the stylesheet keys off.
 *
 * Brightness (`data-theme`) and skin (`data-appearance`) are separate axes.
 * This key is its own localStorage entry for the same reason `pqp-theme` is:
 * the boot script in `index.html` has to set the attribute before the bundle
 * loads, and it must not parse the audio-settings blob to do that.
 */

import type { AppearancePreference } from "@pqp/shared";
import { queuePreferenceSync } from "@/lib/preferences";

export type { AppearancePreference };

export const APPEARANCE_STORAGE_KEY = "pqp-appearance";
export const DEFAULT_APPEARANCE: AppearancePreference = "signal";

export const APPEARANCES = ["signal", "harmony", "hearth", "night"] as const;

export function appearanceForcesDark(
  appearance: AppearancePreference,
): boolean {
  return appearance === "night";
}

export function isAppearance(value: string | null): value is AppearancePreference {
  return (
    value === "signal" ||
    value === "harmony" ||
    value === "hearth" ||
    value === "night"
  );
}

/** `guild` and `accord` were earlier ids for harmony. */
export function normalizeAppearance(
  value: string | null,
): AppearancePreference | null {
  if (value === "guild" || value === "accord") {
    return "harmony";
  }
  return isAppearance(value) ? value : null;
}

export function readStoredAppearance(): AppearancePreference | null {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return normalizeAppearance(raw);
  } catch {
    return null;
  }
}

export function storeAppearance(appearance: AppearancePreference): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // Persistence is a convenience. The session still skins correctly.
  }
}

export function applyAppearance(appearance: AppearancePreference): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.appearance = appearance;
}

const listeners = new Set<() => void>();

let state: AppearancePreference = readStoredAppearance() ?? DEFAULT_APPEARANCE;

export function getAppearance(): AppearancePreference {
  return state;
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(appearance: AppearancePreference): void {
  if (appearance === state) {
    return;
  }
  state = appearance;
  applyAppearance(appearance);
  for (const listener of listeners) {
    listener();
  }
}

/** A choice the user just made here: apply it, keep it, and send it on. */
export function setAppearancePreference(appearance: AppearancePreference): void {
  storeAppearance(appearance);
  commit(appearance);
  queuePreferenceSync({ appearance }, { immediate: true });
}

/**
 * Take the appearance the account already carries, as returned by `/api/me`.
 *
 * Deliberately does not sync back. Same rule as theme: the value came from the
 * server, so writing it again would let a stale tab overwrite a newer choice.
 */
export function adoptAppearancePreference(appearance: AppearancePreference): void {
  storeAppearance(appearance);
  commit(appearance);
}

if (typeof document !== "undefined") {
  if (!document.documentElement.dataset.appearance) {
    applyAppearance(state);
  }
}

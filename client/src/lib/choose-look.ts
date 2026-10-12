/**
 * Picking a look, from the Aparência picker or from the seasonal corner card.
 *
 * One function so both doors keep the same promise: a dark-only look (Night,
 * Halloween, Christmas) pins the mode to dark, and leaving it gives back the
 * mode the person had before. Moving between two dark-only looks keeps the note, so
 * Night to Halloween to Clássico still lands on Light for a Light user.
 */

import {
  adoptAppearancePreference,
  appearanceForcesDark,
  getAppearance,
  isRetroLookOn,
  setAppearancePreference,
  type AppearancePreference,
} from "@/lib/appearance";
import {
  getThemeState,
  setThemePreference,
  type ThemePreference,
} from "@/lib/theme";

/**
 * Where "the mode before a dark-only look" is remembered. The theme store
 * writes dark over the account's choice while such a look is on, so without
 * this note leaving it would leave a person who used Light (or Automático) on
 * Dark. Local to this browser on purpose: another device has its own history.
 * The key keeps its Night-era name so a note written before seasonal looks
 * existed still restores.
 */
export const MODE_BEFORE_NIGHT_KEY = "pqp:mode-before-night";

export function rememberModeBeforeNight(mode: ThemePreference): void {
  try {
    localStorage.setItem(MODE_BEFORE_NIGHT_KEY, mode);
  } catch {
    // Remembering is a convenience; leaving the look then stays on Dark.
  }
}

/** The remembered mode, once. Reading it forgets it. */
export function takeModeBeforeNight(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(MODE_BEFORE_NIGHT_KEY);
    localStorage.removeItem(MODE_BEFORE_NIGHT_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
  } catch {
    return null;
  }
}

export function chooseLook(next: AppearancePreference): void {
  const current = getAppearance();
  if (next === "retro") {
    // Modo 2005 paints over the look underneath, which keeps its mode.
    setAppearancePreference(next);
    return;
  }
  if (next === current) {
    if (isRetroLookOn()) {
      // Leaving Modo 2005 for the look that was under it: nothing else moves.
      setAppearancePreference(next);
    }
    return;
  }
  const wasDarkOnly = appearanceForcesDark(current);
  const willBeDarkOnly = appearanceForcesDark(next);
  if (willBeDarkOnly && !wasDarkOnly) {
    // Entering a dark-only look. Note the mode first.
    rememberModeBeforeNight(getThemeState().preference);
  }
  setAppearancePreference(next);
  if (wasDarkOnly && !willBeDarkOnly) {
    const before = takeModeBeforeNight();
    if (before && before !== "dark") {
      setThemePreference(before);
    }
  }
}

/**
 * Take the account's look, as `/api/me` returns it. A dark-only look picked on
 * another device moves this one to dark, so note this device's mode first, the
 * way a pick made here does. Otherwise leaving the look here would keep a Light
 * user on Dark.
 */
export function adoptLook(
  appearance: AppearancePreference | undefined,
  /** `preferenceWriteGeneration()` when the read began, if the caller noted it. */
  readGeneration?: number,
): void {
  const lookBefore = getAppearance();
  const modeBefore = getThemeState().preference;
  adoptAppearancePreference(appearance, readGeneration);
  if (
    appearanceForcesDark(getAppearance()) &&
    !appearanceForcesDark(lookBefore)
  ) {
    rememberModeBeforeNight(modeBefore);
  }
}

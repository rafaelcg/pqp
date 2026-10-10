/**
 * Picking a look, from the Aparência picker or from the seasonal corner card.
 *
 * One function so both doors keep the same promise: a dark-only look (Night,
 * Halloween, Christmas) pins the mode to dark, and leaving it gives back the
 * mode the person had before. Moving between two dark-only looks keeps the note, so
 * Night to Halloween to Clássico still lands on Light for a Light user.
 */

import {
  appearanceForcesDark,
  getAppearance,
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
  if (next === current) {
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

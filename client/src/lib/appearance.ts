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

/**
 * MODO 2005, the hidden fifth look. `data-appearance="retro"` like any other
 * skin, so the stylesheet, the bench and `/qa/ui` treat it as one, but it sits
 * ON TOP of the synced preference instead of replacing it.
 *
 * Why an overlay and not a fifth enum member: the account's `appearance` is
 * validated by the server (`appearancePreferenceSchema` in `@pqp/shared`),
 * which does not know `retro` yet, and a PATCH it refuses would also lose
 * whatever else rode in the same write. So the synced value stays the look
 * underneath (Clássico, Harmonia...), which is also exactly what "turn it off
 * and get my old look back" needs, and `retro` is this browser's own choice.
 * When the shared enum learns `retro`, this can become a plain preference.
 *
 * Kept in this module rather than in `retro-look.ts` because `applyAppearance`
 * is the one writer of the attribute, and two writers would fight over it.
 */
export type Look = AppearancePreference | "retro";

export const RETRO_STORAGE_KEY = "pqp-appearance-retro";
/** Set while the operator's `retro_look` kill switch is off. The boot script reads it. */
export const RETRO_KILLED_STORAGE_KEY = "pqp-retro-killed";

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

/** `guild` and `accord` were earlier ids for harmony. The boot script in
 * `client/index.html` repeats this mapping and cannot import it. */
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

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(key, "1");
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Persistence is a convenience. The session still skins correctly.
  }
}

let retroChosen = readFlag(RETRO_STORAGE_KEY);
let retroAvailable = !readFlag(RETRO_KILLED_STORAGE_KEY);

export function applyAppearance(appearance: AppearancePreference): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.appearance =
    retroChosen && retroAvailable ? "retro" : appearance;
}

const listeners = new Set<() => void>();

let state: AppearancePreference = readStoredAppearance() ?? DEFAULT_APPEARANCE;

export function getAppearance(): AppearancePreference {
  return state;
}

/** What is actually painted: Modo 2005 when it is on, otherwise the preference. */
export function getLook(): Look {
  return retroChosen && retroAvailable ? "retro" : state;
}

export function isRetroLookOn(): boolean {
  return retroChosen && retroAvailable;
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function commit(appearance: AppearancePreference): void {
  if (appearance === state) {
    return;
  }
  state = appearance;
  applyAppearance(appearance);
  notify();
}

/** Turn Modo 2005 on or off in this browser. Never synced; see `Look`. */
export function setRetroLook(on: boolean): void {
  if (on === retroChosen) {
    return;
  }
  retroChosen = on;
  writeFlag(RETRO_STORAGE_KEY, on);
  applyAppearance(state);
  notify();
}

/**
 * The operator's kill switch. Off paints the preference underneath and keeps
 * the person's choice, so turning the switch back on gives them the look back.
 */
export function setRetroLookAvailable(available: boolean): void {
  writeFlag(RETRO_KILLED_STORAGE_KEY, !available);
  if (available === retroAvailable) {
    return;
  }
  retroAvailable = available;
  applyAppearance(state);
  notify();
}

export function isRetroLookAvailable(): boolean {
  return retroAvailable;
}

/** A choice the user just made here: apply it, keep it, and send it on. */
export function setAppearancePreference(appearance: AppearancePreference): void {
  // Picking any look in Aparência is also one of the ways out of Modo 2005.
  if (retroChosen) {
    retroChosen = false;
    writeFlag(RETRO_STORAGE_KEY, false);
    applyAppearance(state);
    notify();
  }
  storeAppearance(appearance);
  commit(appearance);
  // Night also pins brightness. One PATCH so the account learns both keys
  // without a second immediate write. Local theme persist is theme.ts's
  // appearance subscription, which must not import this module.
  queuePreferenceSync(
    appearanceForcesDark(appearance)
      ? { appearance, theme: "dark" }
      : { appearance },
    { immediate: true },
  );
}

/**
 * Take the appearance the account already carries, as returned by `/api/me`.
 *
 * Deliberately does not sync back. Same rule as theme: the value came from the
 * server, so writing it again would let a stale tab overwrite a newer choice.
 * Modo 2005 stays on: the server only knows the look underneath it.
 */
export function adoptAppearancePreference(appearance: AppearancePreference): void {
  storeAppearance(appearance);
  commit(appearance);
}

/** Tests only: re-read the Modo 2005 keys after a test rewrote storage. */
export function reloadRetroLookForTests(): void {
  retroChosen = readFlag(RETRO_STORAGE_KEY);
  retroAvailable = !readFlag(RETRO_KILLED_STORAGE_KEY);
}

if (typeof document !== "undefined") {
  if (!document.documentElement.dataset.appearance) {
    applyAppearance(state);
  }
}

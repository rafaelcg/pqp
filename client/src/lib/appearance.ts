/**
 * Appearance preference and the DOM attribute the stylesheet keys off.
 *
 * Brightness (`data-theme`) and skin (`data-appearance`) are separate axes.
 * This key is its own localStorage entry for the same reason `pqp-theme` is:
 * the boot script in `index.html` has to set the attribute before the bundle
 * loads, and it must not parse the audio-settings blob to do that.
 */

import type { AppearancePreference } from "@pqp/shared";
import {
  isPreferencePending,
  preferenceWrittenSince,
  queuePreferenceSync,
} from "@/lib/preferences";

export type { AppearancePreference };

export const APPEARANCE_STORAGE_KEY = "pqp-appearance";
export const DEFAULT_APPEARANCE: AppearancePreference = "signal";

export const APPEARANCES = [
  "signal",
  "harmony",
  "hearth",
  "night",
  "halloween",
  "christmas",
] as const;

/**
 * MODO 2005, the hidden fifth look. `data-appearance="retro"` like any other
 * skin, so the stylesheet, the bench and `/qa/ui` treat it as one.
 *
 * ON THE ACCOUNT, `appearance: "retro"` is the whole truth: the look follows
 * the person to every device. IN THIS MODULE it is an overlay on the look
 * underneath (Clássico, Harmonia...), because "turn it off and get my old look
 * back" needs that look, and the account does not keep it. So `state` is
 * always the look underneath, `retroChosen` says whether Modo 2005 is painted
 * over it, `pqp-appearance-retro` is the fast-path copy the boot script reads,
 * and the server's answer wins whenever it arrives (`adoptAppearancePreference`).
 *
 * The one exception is a browser that turned the look on while it was still
 * local-only (before this synced): its first answer from the server cannot
 * know about it, so it is sent up once instead of being undone. After any
 * write or read of the account's look, `pqp-appearance-retro-synced` marks
 * the account as the source of truth.
 *
 * Kept in this module rather than in `retro-look.ts` because `applyAppearance`
 * is the one writer of the attribute, and two writers would fight over it.
 */
export type Look = AppearancePreference;

export const RETRO_STORAGE_KEY = "pqp-appearance-retro";
/** Set while the operator's `retro_look` kill switch is off. The boot script reads it. */
export const RETRO_KILLED_STORAGE_KEY = "pqp-retro-killed";
/** Set once this browser's Modo 2005 state has met the account's. */
export const RETRO_SYNCED_STORAGE_KEY = "pqp-appearance-retro-synced";

/**
 * What to do with the account's look, given this browser's. Pure, so the merge
 * rules are tested on their own:
 *  - the account says retro: paint it (`retro: true`), keep the look underneath;
 *  - the account names another look: that look, retro off; unless this browser
 *    turned retro on before the look synced (`localRetro && !synced`), then
 *    keep it and send it up (`push: true`).
 */
export function mergeAccountAppearance(input: {
  account: AppearancePreference;
  localRetro: boolean;
  synced: boolean;
}): { retro: boolean; base: AppearancePreference | null; push: boolean } {
  if (input.account === "retro") {
    return { retro: true, base: null, push: false };
  }
  if (input.localRetro && !input.synced) {
    return { retro: true, base: input.account, push: true };
  }
  return { retro: false, base: input.account, push: false };
}

/** Night and the seasonal looks only exist in dark. */
export function appearanceForcesDark(
  appearance: AppearancePreference,
): boolean {
  return (
    appearance === "night" ||
    appearance === "halloween" ||
    appearance === "christmas"
  );
}

export function isAppearance(value: string | null): value is AppearancePreference {
  return (
    value === "signal" ||
    value === "harmony" ||
    value === "hearth" ||
    value === "night" ||
    value === "halloween" ||
    value === "christmas"
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

/** An older tab adopted the account's `retro` as a plain look id. */
function storedLookIsRetro(): boolean {
  try {
    return localStorage.getItem(APPEARANCE_STORAGE_KEY) === "retro";
  } catch {
    return false;
  }
}

let retroChosen = readFlag(RETRO_STORAGE_KEY) || storedLookIsRetro();
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

function paintRetro(on: boolean): boolean {
  if (on === retroChosen) {
    return false;
  }
  retroChosen = on;
  writeFlag(RETRO_STORAGE_KEY, on);
  applyAppearance(state);
  notify();
  return true;
}

/** The account's look, written now: `retro` or the look underneath. */
function syncLook(): void {
  writeFlag(RETRO_SYNCED_STORAGE_KEY, true);
  queuePreferenceSync(
    { appearance: retroChosen ? "retro" : state },
    { immediate: true },
  );
}

/** Turn Modo 2005 on or off, here and on the account. */
export function setRetroLook(on: boolean): void {
  if (paintRetro(on)) {
    syncLook();
  }
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
  if (appearance === "retro") {
    setRetroLook(true);
    return;
  }
  // Picking any look in Aparência is also one of the ways out of Modo 2005.
  paintRetro(false);
  writeFlag(RETRO_SYNCED_STORAGE_KEY, true);
  storeAppearance(appearance);
  commit(appearance);
  // Night and the seasonal looks also pin brightness. One PATCH so the account learns both keys
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
 * The one write is the migration in `mergeAccountAppearance`: a Modo 2005
 * turned on here before the look synced is sent up once rather than undone.
 */
export function adoptAppearancePreference(
  appearance: AppearancePreference | undefined,
  /** `preferenceWriteGeneration()` when the read began, if the caller noted it. */
  readGeneration?: number,
): void {
  // A look this tab chose after the read began (answered or not) is newer
  // than what the read says; adopting it would undo the choice.
  if (
    isPreferencePending("appearance") ||
    (readGeneration !== undefined &&
      preferenceWrittenSince("appearance", readGeneration))
  ) {
    return;
  }
  if (appearance === undefined) {
    // An account that never chose a look: nothing to adopt, but a Modo 2005
    // turned on here before the look synced still has to reach it.
    if (retroChosen && !readFlag(RETRO_SYNCED_STORAGE_KEY)) {
      syncLook();
    }
    return;
  }
  const merged = mergeAccountAppearance({
    account: appearance,
    localRetro: retroChosen,
    synced: readFlag(RETRO_SYNCED_STORAGE_KEY),
  });
  if (merged.base) {
    storeAppearance(merged.base);
    commit(merged.base);
  } else if (storedLookIsRetro()) {
    // An older tab wrote the account's id as a look; the look underneath is
    // unknown here, so it is the default.
    storeAppearance(DEFAULT_APPEARANCE);
    commit(DEFAULT_APPEARANCE);
  }
  paintRetro(merged.retro);
  if (merged.push) {
    syncLook();
  } else {
    writeFlag(RETRO_SYNCED_STORAGE_KEY, true);
  }
}

/** Tests only: re-read the Modo 2005 keys after a test rewrote storage. */
export function reloadRetroLookForTests(): void {
  retroChosen = readFlag(RETRO_STORAGE_KEY) || storedLookIsRetro();
  retroAvailable = !readFlag(RETRO_KILLED_STORAGE_KEY);
}

if (typeof document !== "undefined") {
  if (!document.documentElement.dataset.appearance) {
    applyAppearance(state);
  }
}

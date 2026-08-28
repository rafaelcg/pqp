import { browserStorage } from "./arrival";

/**
 * One-shot "cargos are a checklist" card. Survives reloads on a real host.
 * localhost / 127.0.0.1 never record the impression, so a local preview
 * comes back on every refresh.
 */
export const CARGOS_HINT_STORAGE_KEY = "pqp:cargos-hint-2026-08";

export function shouldPersistCargosHint(
  hostname: string = typeof window === "undefined"
    ? ""
    : window.location.hostname,
): boolean {
  return hostname !== "localhost" && hostname !== "127.0.0.1";
}

/**
 * Has this device already been shown the card?
 *
 * Missing or hostile storage answers `true` — an unsolicited card that
 * cannot be dismissed is worse than a missed impression. localhost always
 * answers `false`.
 */
export function isCargosHintSeen(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
  persist: boolean = shouldPersistCargosHint(),
): boolean {
  if (!persist) {
    return false;
  }
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(CARGOS_HINT_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * Record the impression. Written when the card is shown, not when it is
 * dismissed: scrolling past it still counts. No-op on localhost.
 */
export function rememberCargosHint(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
  persist: boolean = shouldPersistCargosHint(),
): void {
  if (!persist) {
    return;
  }
  try {
    storage?.setItem(CARGOS_HINT_STORAGE_KEY, "1");
  } catch {
    // Session-only hide lives in the component that called this.
  }
}

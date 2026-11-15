import {
  isAutomatedBrowser as isAutomated,
  isHintSeen,
  rememberHint,
  shouldPersistHints,
} from "./hints";

export const CARGOS_HINT_STORAGE_KEY = "pqp:cargos-hint-2026-08";

/** See `lib/hints.ts`; kept as a name so call sites and tests read the same. */
export function shouldPersistCargosHint(hostname?: string): boolean {
  return shouldPersistHints(hostname);
}

/** Re-exported for the imports that grew around this file; lives in `hints`. */
export function isAutomatedBrowser(
  nav?: { webdriver?: boolean } | undefined,
): boolean {
  return arguments.length === 0 ? isAutomated() : isAutomated(nav);
}

export function isCargosHintSeen(
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return isHintSeen(CARGOS_HINT_STORAGE_KEY, storage, persist);
}

export function rememberCargosHint(
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  rememberHint(CARGOS_HINT_STORAGE_KEY, storage, persist);
}

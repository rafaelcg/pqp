import { isIOSDevice } from "./downloads";
import { isStandaloneDisplayMode } from "./fullscreen";
import { isHintSeen, rememberHint, shouldPersistHints } from "./hints";

/**
 * "Add pqp to your home screen for a full-screen cinema."
 *
 * An iPhone in a browser tab cannot give a share the whole screen: Safari
 * has no element fullscreen and keeps its bars. Installed to the home screen
 * the same page gets every pixel. This is the one line that says so, on the
 * stage, once per browser, and only where it is true: iOS, in a tab.
 *
 * Persistence is `lib/hints.ts` (one store), which never persists on
 * `localhost`. The suite that proves "once, and not after dismiss" needs it
 * to persist there, so `HINTS_PERSIST_OVERRIDE_KEY` in `localStorage` turns
 * the store's localhost rule off for this hint. Nothing in production sets it.
 */

export const CINEMA_HINT_STORAGE_KEY = "pqp:cinema-hint-2026-09";
export const HINTS_PERSIST_OVERRIDE_KEY = "pqp:hints-persist";

export function cinemaHintPersists(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
  hostname?: string,
): boolean {
  if (shouldPersistHints(hostname)) {
    return true;
  }
  try {
    return storage?.getItem(HINTS_PERSIST_OVERRIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isCinemaHintSeen(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
  persist: boolean = cinemaHintPersists(storage),
): boolean {
  return isHintSeen(CINEMA_HINT_STORAGE_KEY, storage, persist);
}

export function rememberCinemaHint(
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
  persist: boolean = cinemaHintPersists(storage),
): void {
  rememberHint(CINEMA_HINT_STORAGE_KEY, storage, persist);
}

export interface CinemaHintAudience {
  ios: boolean;
  standalone: boolean;
  seen: boolean;
}

export function readCinemaHintAudience(
  input: Partial<CinemaHintAudience> = {},
): CinemaHintAudience {
  return {
    ios: input.ios ?? isIOSDevice(),
    standalone: input.standalone ?? isStandaloneDisplayMode(),
    seen: input.seen ?? isCinemaHintSeen(),
  };
}

/** iOS, in a browser tab, not yet dismissed. Everyone else already has a real fullscreen. */
export function shouldShowCinemaHint(
  audience: CinemaHintAudience = readCinemaHintAudience(),
): boolean {
  return audience.ios && !audience.standalone && !audience.seen;
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

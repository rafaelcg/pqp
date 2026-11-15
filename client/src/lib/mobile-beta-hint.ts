import { isAutomatedBrowser } from "./cargos-hint";
import { isDesktopApp } from "./desktop";
import { isAndroidDevice, isIOSDevice } from "./downloads";
import { isHintSeen, rememberHint, shouldPersistHints } from "./hints";

export const MOBILE_BETA_HINT_STORAGE_KEY = "pqp:mobile-beta-hint-2026-08";

/** See `lib/hints.ts`; kept as a name so call sites and tests read the same. */
export function shouldPersistMobileBetaHint(hostname?: string): boolean {
  return shouldPersistHints(hostname);
}

export function isMobileBetaHintSeen(
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return isHintSeen(MOBILE_BETA_HINT_STORAGE_KEY, storage, persist);
}

export function rememberMobileBetaHint(
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  rememberHint(MOBILE_BETA_HINT_STORAGE_KEY, storage, persist);
}

export interface MobileBetaAudience {
  automated: boolean;
  desktopApp: boolean;
  android: boolean;
  ios: boolean;
  seen: boolean;
}

/**
 * Signals for the current browser. Kept as a default argument so the
 * audience rule stays unit-testable without stubbing `navigator`.
 */
export function readMobileBetaAudience(
  input: {
    automated?: boolean;
    desktopApp?: boolean;
    android?: boolean;
    ios?: boolean;
    seen?: boolean;
  } = {},
): MobileBetaAudience {
  return {
    automated: input.automated ?? isAutomatedBrowser(),
    desktopApp: input.desktopApp ?? isDesktopApp(),
    android: input.android ?? isAndroidDevice(),
    ios: input.ios ?? isIOSDevice(),
    seen: input.seen ?? isMobileBetaHintSeen(),
  };
}

/**
 * Phone browsers that have not seen the card. Desktop, Electron, Playwright,
 * and anyone who already dismissed it are out.
 */
export function shouldShowMobileBetaHint(
  audience: MobileBetaAudience = readMobileBetaAudience(),
): boolean {
  if (audience.automated || audience.desktopApp || audience.seen) {
    return false;
  }
  return audience.android || audience.ios;
}

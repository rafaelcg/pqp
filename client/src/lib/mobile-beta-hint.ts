import { browserStorage } from "./arrival";
import { isAutomatedBrowser } from "./cargos-hint";
import { isDesktopApp } from "./desktop";
import { isAndroidDevice, isIOSDevice } from "./downloads";

/**
 * One-shot "there is a native app" card for people already in `/app` on a
 * phone. Survives reloads on a real host. localhost / 127.0.0.1 never
 * record the impression, so a local preview comes back on every refresh.
 *
 * Desktop browsers never see this: they already have the "Baixa o app"
 * strip and the three-icon picker. Electron never sees it because it *is*
 * the app.
 */
export const MOBILE_BETA_HINT_STORAGE_KEY = "pqp:mobile-beta-hint-2026-08";

export function shouldPersistMobileBetaHint(
  hostname: string = typeof window === "undefined"
    ? ""
    : window.location.hostname,
): boolean {
  return hostname !== "localhost" && hostname !== "127.0.0.1";
}

export function isMobileBetaHintSeen(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
  persist: boolean = shouldPersistMobileBetaHint(),
): boolean {
  if (!persist) {
    return false;
  }
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(MOBILE_BETA_HINT_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * Record the impression. Written when the card is shown, not when it is
 * dismissed: scrolling past it still counts. No-op on localhost.
 */
export function rememberMobileBetaHint(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
  persist: boolean = shouldPersistMobileBetaHint(),
): void {
  if (!persist) {
    return;
  }
  try {
    storage?.setItem(MOBILE_BETA_HINT_STORAGE_KEY, "1");
  } catch {
    // Session-only hide lives in the component that called this.
  }
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

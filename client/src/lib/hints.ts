import { browserStorage } from "./arrival";

/**
 * One store for every "show this once" surface: the QG invite, the mobile
 * beta card, the What's new pack, the cargos tip, the download strip.
 *
 * Before this each of them carried its own copy of the same three functions
 * (is it seen, remember it, does this host persist) with drift between the
 * copies: one lacked the localhost escape hatch, one lacked the automation
 * guard, and the What's new prompt re-read `navigator.webdriver` inline. The
 * per-surface libs still exist and keep their exported names, so call sites
 * and tests are untouched; they are thin wrappers over these.
 *
 * THE RULES, ONCE:
 *  - `localhost` / `127.0.0.1` never persist, so a developer sees every card
 *    on every reload without clearing storage;
 *  - Playwright (`navigator.webdriver`) never sees a card, because a corner
 *    card over the composer or the call stage is what a screenshot suite
 *    would otherwise measure;
 *  - hostile or missing storage reads as "already seen": a card that cannot
 *    remember itself would come back on every navigation in a private tab.
 */

export type HintStorage = Pick<Storage, "getItem" | "setItem"> | null;

export function shouldPersistHints(
  hostname: string = typeof window === "undefined"
    ? ""
    : window.location.hostname,
): boolean {
  return hostname !== "localhost" && hostname !== "127.0.0.1";
}

export function isAutomatedBrowser(
  nav: { webdriver?: boolean } | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): boolean {
  return Boolean(nav?.webdriver);
}

export function isHintSeen(
  key: string,
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
  persist: boolean = shouldPersistHints(),
): boolean {
  if (!persist) {
    return false;
  }
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(key) === "1";
  } catch {
    return true;
  }
}

export function rememberHint(
  key: string,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
  persist: boolean = shouldPersistHints(),
): void {
  if (!persist) {
    return;
  }
  try {
    storage?.setItem(key, "1");
  } catch {
    // Session-only hide lives in the component that called this.
  }
}

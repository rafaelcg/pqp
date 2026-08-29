import { browserStorage } from "./arrival";

/**
 * One-shot "come by the QG" card. Survives reloads on a real host.
 * localhost / 127.0.0.1 never record the impression, so a local preview
 * comes back on every refresh.
 *
 * The slug is the hosted HQ. A self-host that does not list this community
 * never shows the card (lookup fails, and preview is localhost-only).
 */
export const QG_HINT_SLUG = "qg-do-pqp";
export const QG_HINT_STORAGE_KEY = "pqp:qg-hint-2026-08";

export function shouldPersistQgHint(
  hostname: string = typeof window === "undefined"
    ? ""
    : window.location.hostname,
): boolean {
  return hostname !== "localhost" && hostname !== "127.0.0.1";
}

export function isQgHintSeen(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
  persist: boolean = shouldPersistQgHint(),
): boolean {
  if (!persist) {
    return false;
  }
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(QG_HINT_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function rememberQgHint(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
  persist: boolean = shouldPersistQgHint(),
): void {
  if (!persist) {
    return;
  }
  try {
    storage?.setItem(QG_HINT_STORAGE_KEY, "1");
  } catch {
    // Session-only hide lives in the component that called this.
  }
}

/**
 * Whether the card should mount, once lookup has settled.
 *
 * `listed` is "this instance has a public community at the QG slug".
 * `preview` is localhost: show the art even when the community is missing,
 * so a visual pass does not depend on seeding production's HQ.
 */
export function shouldShowQgHint(input: {
  automated: boolean;
  seen: boolean;
  listed: boolean;
  joined: boolean;
  preview: boolean;
}): boolean {
  if (input.automated || input.seen) {
    return false;
  }
  if (input.listed) {
    return !input.joined;
  }
  return input.preview;
}

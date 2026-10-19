import { isHintSeen, rememberHint } from "@/lib/hints";

/**
 * The one first-run card for apps: "Novo: apps no canal". Once per person (per
 * browser, like every corner card, through `lib/hints.ts`), and only ever drawn
 * where the `apps` flag is on for the open server, so a server that cannot
 * start an app is never told about one.
 */
export const APPS_HINT_STORAGE_KEY = "pqp:apps-hint-2026-10";

export function isAppsHintSeen(
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return isHintSeen(APPS_HINT_STORAGE_KEY, storage, persist);
}

export function rememberAppsHint(
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  rememberHint(APPS_HINT_STORAGE_KEY, storage, persist);
}

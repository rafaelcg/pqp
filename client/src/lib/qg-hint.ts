import {
  isHintSeen,
  rememberHint,
  shouldPersistHints,
} from "./hints";

export const QG_HINT_SLUG = "qg-do-pqp";
export const QG_HINT_STORAGE_KEY = "pqp:qg-hint-2026-08";

/** See `lib/hints.ts`; kept as a name so call sites and tests read the same. */
export function shouldPersistQgHint(hostname?: string): boolean {
  return shouldPersistHints(hostname);
}

export function isQgHintSeen(
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return isHintSeen(QG_HINT_STORAGE_KEY, storage, persist);
}

export function rememberQgHint(
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  rememberHint(QG_HINT_STORAGE_KEY, storage, persist);
}

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

export function qgHintCanJoin(communityId: string | null): boolean {
  return communityId !== null;
}

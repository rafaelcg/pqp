/**
 * In-app "this just shipped" cards. One pack per ship, remembered forever.
 *
 * Not sessionStorage. The Android beta card was a campaign: missing it on a
 * shared machine was worse than seeing it twice. A feature card is the opposite.
 * Once you have seen `/roll`, showing the same card tomorrow is spam.
 *
 * Hostile or missing storage answers "already seen". A card that cannot
 * remember itself would come back on every navigation in Safari private mode.
 */

export const WHATS_NEW_STORAGE_KEY = "pqp:whats-new";

/** Bump this when the next ship needs its own card. Unseen packs show again. */
export const WHATS_NEW_PACK_ID = "novidades-rail";

export function browserLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isWhatsNewSeen(
  packId: string = WHATS_NEW_PACK_ID,
  storage: Pick<Storage, "getItem"> | null = browserLocalStorage(),
): boolean {
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(WHATS_NEW_STORAGE_KEY) === packId;
  } catch {
    return true;
  }
}

export function rememberWhatsNew(
  packId: string = WHATS_NEW_PACK_ID,
  storage: Pick<Storage, "setItem"> | null = browserLocalStorage(),
): void {
  try {
    storage?.setItem(WHATS_NEW_STORAGE_KEY, packId);
  } catch {
    // Quota or a denied store. React state still hides it for this session.
  }
}

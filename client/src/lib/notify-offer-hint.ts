import { isHintSeen, rememberHint } from "./hints";

export const NOTIFY_OFFER_HINT_STORAGE_KEY = "pqp:notify-offer-2026-10";

/** See `lib/hints.ts`: never on localhost, never under automation. */
export function isNotifyOfferSeen(
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return isHintSeen(NOTIFY_OFFER_HINT_STORAGE_KEY, storage, persist);
}

export function rememberNotifyOffer(
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  rememberHint(NOTIFY_OFFER_HINT_STORAGE_KEY, storage, persist);
}

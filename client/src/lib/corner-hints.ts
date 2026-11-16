import { hintDietHides } from "./hint-diet";

/**
 * One card at a time.
 *
 * The Baú post card, the notification offer and the listing nudge all pin to
 * `right-4 bottom-4`. Showing two is a stack, not a queue: the one underneath
 * still records its impression, so the person never sees it. First match in
 * this list is the only one allowed to mount. "Never two cards on screen at
 * once" is a product rule, not a layout one.
 *
 * Order is product, not recency. The QG invite, the phone beta invite,
 * Novidades, cargos, the shortcut map, the apps news, the forum news, the
 * Voz limpa nudge and the seasonal look cards were removed on 2026-11-01.
 * (A waiting build used to be the first card here. It is the quiet update
 * indicator now and takes no corner at all.)
 *  1. communityHomePost: a live Baú publish in the open server; not a
 *     campaign
 *  2. notifyOffer: a DM or mention reached a hidden tab and banners are off;
 *     a moment rather than a campaign (`lib/notifications.ts`, `NotifyOfferHint`)
 *  3. listingNudge: once, to the owner of a room with a public address
 *     that is not in the directory (`lib/community-listing-nudge.ts`)
 */
export const CORNER_HINT_ORDER = [
  "communityHomePost",
  "notifyOffer",
  "listingNudge",
] as const;
export type CornerHintId = (typeof CORNER_HINT_ORDER)[number];

/**
 * A Baú publish and a missed-DM notification offer are things that happened,
 * not campaigns: a quiet context never holds them (`lib/hint-quiet.ts`).
 */
export const QUIET_EXEMPT_CORNER_IDS: ReadonlySet<CornerHintId> = new Set([
  "communityHomePost",
  "notifyOffer",
]);

/**
 * `quiet`: unsolicited hints wait (a quiet context, or the hint switches have
 * not been read yet; see `lib/hint-quiet.ts`). The ids in
 * `QUIET_EXEMPT_CORNER_IDS` still win. A hidden-by-the-diet id
 * is skipped before anything else (`lib/hint-diet.ts`), so the next card in
 * line takes the corner and nothing is stored for the one skipped.
 */
export function winningCornerHint(
  wanting: Partial<Record<CornerHintId, boolean>>,
  options: { quiet?: boolean } = {},
): CornerHintId | null {
  for (const id of CORNER_HINT_ORDER) {
    if (!wanting[id] || hintDietHides(id)) {
      continue;
    }
    if (options.quiet && !QUIET_EXEMPT_CORNER_IDS.has(id)) {
      continue;
    }
    return id;
  }
  return null;
}

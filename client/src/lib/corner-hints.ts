import { hintDietHides } from "./hint-diet";

/**
 * One card at a time.
 *
 * QG, the Android/iOS beta invite, Novidades, and cargos
 * all pin to `right-4 bottom-4`. Showing two is a stack, not a queue: the
 * one underneath still records its impression, so the person never sees it.
 * First match in this list is the only one allowed to mount. Not every id
 * here draws in that corner — `voiceClean` renders inline above the user
 * bar (`components/voice/voice-clean-hint.tsx`) — but it shares this list
 * because "never two cards on screen at once" is a product rule, not a
 * layout one.
 *
 * Order is product, not recency:
 *  (A waiting build used to be 1 here, a card that beat every campaign. It is
 *  the quiet update indicator now and takes no corner at all.)
 *  2. communityHomePost — a live Baú publish in the open server; not a
 *     campaign, so it beats the first-run cards
 *  3. notifyOffer — a DM or mention reached a hidden tab and banners are off;
 *     a moment rather than a campaign (`lib/notifications.ts`, `NotifyOfferHint`)
 *  4. qg — the house, first-run
 *  4b. listingNudge: once, to the owner of a room with a public address
 *     that is not in the directory (`lib/community-listing-nudge.ts`)
 *  5. voiceClean — the one-time Voz limpa nudge, above the user bar; after
 *     the first-run cards, before the app-invite campaigns (`lib/voice-clean.ts`)
 *  6. seasonalLook: "the Halloween look is here", once per season; a short
 *     window, so it goes before the year-round campaigns (`lib/seasonal-looks.ts`)
 *  7. mobileBeta — phone browsers only; the campaign for the native apps
 *  8. whatsNew — Novidades now lives on the rail
 *  8b. appsNews — "Novo: apps no canal", once, only where the `apps` flag is on
 *     for the open server (`lib/apps/apps-hint.ts`)
 *  9. cargos — staff who can manage roles
 * 10. shortcuts — Cmd+/ map; last, and skipped while an attached feature
 *     hint is up (see `lib/feature-hints.ts`)
 */
export const CORNER_HINT_ORDER = [
  "communityHomePost",
  "notifyOffer",
  "qg",
  "listingNudge",
  "voiceClean",
  "seasonalLook",
  "mobileBeta",
  "whatsNew",
  "appsNews",
  "cargos",
  "shortcuts",
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

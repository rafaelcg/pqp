/**
 * One corner card at a time.
 *
 * The update card, QG, the Android/iOS beta invite, Novidades, and cargos
 * all pin to `right-4 bottom-4`. Showing two is a stack, not a queue: the
 * one underneath still records its impression, so the person never sees it.
 * First match in this list is the only one allowed to mount.
 *
 * Order is product, not recency:
 *  1. update — a waiting build beats every campaign (it is also mounted
 *     outside App; see `lib/update-prompt-state.ts` for how it reports in)
 *  2. qg — the house, first-run
 *  3. mobileBeta — phone browsers only; the campaign for the native apps
 *  4. whatsNew — Novidades now lives on the rail
 *  5. cargos — staff who can manage roles
 */
export const CORNER_HINT_ORDER = [
  "update",
  "qg",
  "mobileBeta",
  "whatsNew",
  "cargos",
] as const;
export type CornerHintId = (typeof CORNER_HINT_ORDER)[number];

export function winningCornerHint(
  wanting: Partial<Record<CornerHintId, boolean>>,
): CornerHintId | null {
  for (const id of CORNER_HINT_ORDER) {
    if (wanting[id]) {
      return id;
    }
  }
  return null;
}

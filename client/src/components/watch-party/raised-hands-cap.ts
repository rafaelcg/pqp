import type { WatchParty } from "@pqp/shared";

/**
 * How many raised hands the options dialog draws before it stops and just
 * counts the rest. Farol flagged the uncapped list (2026-09-13): with voice
 * on and `hosts_only`/`everyone`, every viewer can raise a hand, and a real
 * audience could put hundreds of avatar rows into one dialog on every open.
 */
export const MAX_VISIBLE_HANDS = 20;

/**
 * Splits a raised-hand queue at `MAX_VISIBLE_HANDS`: the rows the dialog
 * actually draws, and how many more are waiting than that. The queue already
 * arrives in the server's own raise order (`docs/RAISED_HANDS.md`), so the
 * visible slice is the people waiting longest, exactly who a host should
 * see first, and not an arbitrary cut. Exported (pure, no Dialog/portal
 * involved) so the cap has a test that does not need a DOM.
 */
export function visibleRaisedHands(
  hands: WatchParty["stage"]["hands"],
): { visible: WatchParty["stage"]["hands"]; hiddenCount: number } {
  return {
    visible: hands.slice(0, MAX_VISIBLE_HANDS),
    hiddenCount: Math.max(0, hands.length - MAX_VISIBLE_HANDS),
  };
}

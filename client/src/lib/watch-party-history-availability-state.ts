import type { WatchPartyHistoryChannel } from "@/lib/watch-party-history-access";

/**
 * Confirmed-history state for `useWatchPartyHistoryAvailability`, pulled out
 * as plain data operations so the bugs review caught on the hook (stale
 * results surviving a server switch, a transient failure caching a
 * permanent "no broadcasts", and a channel's first broadcast never being
 * noticed) can be pinned without a React effect-testing harness, which this
 * repo does not carry.
 *
 * The map only ever grows and only ever holds `true`. There is no `false`
 * entry, anywhere, ever: absence already means "not confirmed yet", which is
 * what makes the failure-retry and first-broadcast cases the same case
 * rather than two bugs needing two fixes.
 */
export type HistoryConfirmedMap = Readonly<Record<string, true>>;

export const EMPTY_HISTORY_CONFIRMED_MAP: HistoryConfirmedMap = {};

/**
 * What the caller should actually show, right now, for these candidates.
 * Filtering through `candidates` on every call -- rather than handing back
 * whatever the map happens to hold -- is the fix for a server switch
 * leaking the PREVIOUS server's channels for a moment: a map entry for a
 * channel that is not among the CURRENT candidates can never surface here,
 * no matter how far behind the map is versus the latest fetch. The map is
 * allowed to be stale; the join with `candidates` is what keeps the answer
 * honest.
 */
export function visibleHistoryChannels(
  candidates: readonly WatchPartyHistoryChannel[],
  confirmed: HistoryConfirmedMap,
): readonly WatchPartyHistoryChannel[] {
  return candidates.filter((channel) => confirmed[channel.id] === true);
}

/**
 * Which candidates still need a request. A channel drops out once confirmed
 * and is never asked again; anything else -- never checked, checked and
 * genuinely empty, or the last check failed -- is asked again next tick.
 * There is deliberately no "checked and empty" state that reads any
 * differently from "checked and failed": a network failure has to retry
 * exactly like "no broadcast yet" does, which is the fix for the
 * permanent-hide-on-failure bug.
 */
export function unconfirmedChannels(
  candidates: readonly WatchPartyHistoryChannel[],
  confirmed: HistoryConfirmedMap,
): readonly WatchPartyHistoryChannel[] {
  return candidates.filter((channel) => confirmed[channel.id] !== true);
}

/**
 * Folds one batch of check results into the map. A failed or negative check
 * contributes nothing -- there is no way to write `false` through this
 * function on purpose, so a caller cannot accidentally reintroduce the
 * permanent-hide bug by passing one through.
 */
export function withConfirmedHistory(
  confirmed: HistoryConfirmedMap,
  newlyConfirmedIds: readonly string[],
): HistoryConfirmedMap {
  if (newlyConfirmedIds.length === 0) {
    return confirmed;
  }
  const next: Record<string, true> = { ...confirmed };
  for (const id of newlyConfirmedIds) {
    next[id] = true;
  }
  return next;
}

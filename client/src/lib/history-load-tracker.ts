/**
 * Orders a channel's history requests so a stale one cannot overrule a newer
 * one.
 *
 * Three paths fetch the open channel's newest page: opening it, the "try
 * again" button, and the reconnect refetch. They can overlap (switch away and
 * back while the first request is still pending, or a reconnect landing during
 * a retry), and they settle in any order. Checking only "is this channel still
 * selected" lets an old request's failure mark history as unavailable after a
 * newer request already loaded it, which leaves an error over messages that are
 * on screen.
 *
 * A failure therefore counts only when it belongs to the newest request and no
 * request has succeeded since it started. A success always counts: whatever it
 * loaded is on screen, so the history is not unavailable.
 *
 * The reconnect refetch only reports successes (`loaded`). It never shows an
 * error of its own, so it must not start a generation either: that would
 * silence the failure of an open or retry still pending beside it and leave
 * the channel on its empty state.
 */
export type HistoryLoad = {
  /** Record that this request loaded the page. */
  succeeded(): void;
  /** Whether this request's failure should be shown to the user. */
  failureStands(): boolean;
};

export type HistoryLoadTracker = {
  /** Start a request whose failure is shown. Call once, before the fetch. */
  begin(): HistoryLoad;
  /** Record a page loaded by a request that shows no failure of its own. */
  loaded(): void;
};

export function createHistoryLoadTracker(): HistoryLoadTracker {
  let latest = 0;
  let successes = 0;
  return {
    begin() {
      const generation = ++latest;
      const successesAtStart = successes;
      return {
        succeeded() {
          successes += 1;
        },
        failureStands() {
          return generation === latest && successes === successesAtStart;
        },
      };
    },
    loaded() {
      successes += 1;
    },
  };
}

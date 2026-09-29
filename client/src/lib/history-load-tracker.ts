/**
 * Orders a channel's history requests so a stale one cannot overrule a newer
 * one.
 *
 * Three paths fetch the open channel's newest page: opening it, the "try
 * again" button, and the reconnect refetch. They can overlap (switch away and
 * back while the first request is still pending, or a reconnect landing during
 * a retry), and they settle in any order. Checking only "is this channel still
 * selected" gets both halves wrong:
 *
 *   - An old request's failure could mark history as unavailable after a
 *     newer request already loaded it, which leaves an error over messages
 *     that are on screen. A failure therefore counts only when it belongs to
 *     the newest request and no request has succeeded since it started.
 *   - An old request's success could replace the page a newer request already
 *     put on screen, dropping every message that arrived in between. A success
 *     is therefore applied only when no request for the same channel that
 *     started later has been applied since the channel was opened. Opening a
 *     different channel clears the screen, so it also clears that record: an
 *     old page for the channel you came back to beats an empty list.
 *
 * Every success still counts against failures, applied or not: a skipped page
 * was skipped because a newer one is on screen, so the history is not
 * unavailable either way.
 *
 * The reconnect refetch never shows an error of its own, so it takes a
 * `quiet` load: ordered like the others, but it does not start a failure
 * generation. One that did would silence the failure of an open or retry
 * still pending beside it and leave the channel on its empty state.
 */
export type QuietHistoryLoad = {
  /**
   * Record that this request loaded the page. Returns whether to put it on
   * screen: false when a later request for the channel already did.
   */
  succeeded(): boolean;
};

export type HistoryLoad = QuietHistoryLoad & {
  /** Whether this request's failure should be shown to the user. */
  failureStands(): boolean;
};

export type HistoryLoadTracker = {
  /**
   * Start a request whose failure is shown. Call once, before the fetch.
   */
  begin(channelId: string): HistoryLoad;
  /**
   * Start a request that shows no failure of its own. Call once, before the
   * fetch.
   */
  quiet(channelId: string): QuietHistoryLoad;
};

export function createHistoryLoadTracker(): HistoryLoadTracker {
  /** Start order of every request, quiet ones included. */
  let started = 0;
  /** The newest request whose failure may be shown. */
  let latest = 0;
  let successes = 0;
  /** The request whose page is on screen, if this channel's is. */
  let applied: { channelId: string; order: number } | null = null;

  const start = (channelId: string) => {
    if (applied && applied.channelId !== channelId) {
      applied = null;
    }
    const order = ++started;
    return () => {
      successes += 1;
      if (applied && applied.channelId === channelId && applied.order > order) {
        return false;
      }
      applied = { channelId, order };
      return true;
    };
  };

  return {
    begin(channelId) {
      const succeeded = start(channelId);
      const generation = ++latest;
      const successesAtStart = successes;
      return {
        succeeded,
        failureStands() {
          return generation === latest && successes === successesAtStart;
        },
      };
    },
    quiet(channelId) {
      return { succeeded: start(channelId) };
    },
  };
}

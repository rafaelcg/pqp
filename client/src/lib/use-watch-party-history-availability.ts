import { useEffect, useReducer, useRef } from "react";
import { fetchWatchPartyHistory } from "@/lib/watch-party-history-api";
import { mapWithConcurrency } from "@/lib/concurrency";
import type { WatchPartyHistoryChannel } from "@/lib/watch-party-history-access";
import {
  EMPTY_HISTORY_CONFIRMED_MAP,
  unconfirmedChannels,
  visibleHistoryChannels,
  withConfirmedHistory,
  type HistoryConfirmedMap,
} from "@/lib/watch-party-history-availability-state";

/**
 * How often an unconfirmed channel (no broadcast seen yet, or the last
 * check failed) is asked again. There is no push signal on this socket for
 * "a broadcast just finished" or "that request you sent a minute ago
 * actually failed" -- this is a poll standing in for both, loose enough to
 * cost nothing noticeable and tight enough that a link shows up within a
 * minute of a show ending or a blip clearing.
 */
const RECHECK_INTERVAL_MS = 60_000;

/** No more than this many history checks in flight at once, however many
 * `watch_party` channels a server has. See `mapWithConcurrency`. */
const MAX_CONCURRENT_CHECKS = 3;

/**
 * Of the channels this viewer is already permitted to see the history of
 * (`watchPartyHistoryCandidates`), which ones actually have a broadcast to
 * show. A moderator on a server that has never gone live should not get a
 * dead-end "Transmissões anteriores" link.
 *
 * Reuses the same endpoint the dialog itself calls
 * (`GET /api/channels/:id/watch-party/history`), with `limit=1` -- cheap,
 * and no new server route.
 *
 * The state transitions this relies on (never caching a negative, only ever
 * filtering through the CURRENT candidates) live in
 * `watch-party-history-availability-state.ts` and are unit tested there;
 * this hook is the thin, un-unit-testable shell around them: an effect, a
 * ref holding the confirmed map across renders, and a poll.
 */
export function useWatchPartyHistoryAvailability(
  candidates: readonly WatchPartyHistoryChannel[],
): readonly WatchPartyHistoryChannel[] {
  const [, notifyConfirmed] = useReducer((tick: number) => tick + 1, 0);
  const confirmedRef = useRef<HistoryConfirmedMap>(
    EMPTY_HISTORY_CONFIRMED_MAP,
  );
  const key = candidates.map((channel) => channel.id).join(",");

  useEffect(() => {
    if (candidates.length === 0) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    function check() {
      const pending = unconfirmedChannels(candidates, confirmedRef.current);
      if (pending.length === 0) {
        return;
      }
      void mapWithConcurrency(pending, MAX_CONCURRENT_CHECKS, (channel) =>
        fetchWatchPartyHistory(channel.id, 1, controller.signal)
          .then((res): string | null =>
            res.broadcasts.length > 0 ? channel.id : null,
          )
          // A failed check (network error, an abort, a 5xx) contributes
          // nothing rather than a negative -- see `withConfirmedHistory`.
          // It is picked up again on the next tick automatically, because
          // it was never written to the map at all.
          .catch(() => null),
      ).then((results) => {
        if (cancelled) {
          return;
        }
        const newlyConfirmed = results.filter(
          (id): id is string => id !== null,
        );
        if (newlyConfirmed.length === 0) {
          return;
        }
        confirmedRef.current = withConfirmedHistory(
          confirmedRef.current,
          newlyConfirmed,
        );
        notifyConfirmed();
      });
    }

    check();
    const timer = window.setInterval(check, RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
    // `key` is `candidates` flattened to the one thing that should restart
    // the poll -- which channels, not the array identity, which changes on
    // every render that computes `candidates` fresh from `channels` +
    // `perms`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Filtered through the CURRENT `candidates` on every render, not read
  // straight off the ref: a confirmed entry left over from a server the
  // viewer just switched away from is not among `candidates` any more and
  // can never be returned, however stale the ref is versus the latest
  // fetch. See `visibleHistoryChannels`.
  return visibleHistoryChannels(candidates, confirmedRef.current);
}

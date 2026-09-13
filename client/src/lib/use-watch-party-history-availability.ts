import { useEffect, useState } from "react";
import { fetchWatchPartyHistory } from "@/lib/watch-party-history-api";
import type { WatchPartyHistoryChannel } from "@/lib/watch-party-history-access";

/**
 * Of the channels this viewer is already permitted to see the history of
 * (`watchPartyHistoryCandidates`), which ones actually have a broadcast to
 * show. A moderator on a server that has never gone live should not get a
 * dead-end "Transmissões anteriores" link.
 *
 * Reuses the same endpoint the dialog itself calls
 * (`GET /api/channels/:id/watch-party/history`), with `limit=1` -- cheap,
 * and no new server route. One request per candidate channel; in practice a
 * server has at most a handful of `watch_party` channels.
 */
export function useWatchPartyHistoryAvailability(
  candidates: readonly WatchPartyHistoryChannel[],
): readonly WatchPartyHistoryChannel[] {
  const [available, setAvailable] = useState<
    readonly WatchPartyHistoryChannel[]
  >([]);
  const key = candidates.map((channel) => channel.id).join(",");

  useEffect(() => {
    if (candidates.length === 0) {
      setAvailable([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      candidates.map((channel) =>
        fetchWatchPartyHistory(channel.id, 1)
          .then((res): WatchPartyHistoryChannel | null =>
            res.broadcasts.length > 0 ? channel : null,
          )
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) {
        return;
      }
      setAvailable(
        results.filter(
          (channel): channel is WatchPartyHistoryChannel => channel !== null,
        ),
      );
    });
    return () => {
      cancelled = true;
    };
    // `key` is `candidates` flattened to the one thing that should retrigger
    // the fetch -- which channels, not the array identity, which changes on
    // every render that computes `candidates` fresh from `channels` + `perms`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return available;
}

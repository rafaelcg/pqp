import type { WatchPartyHistoryEntry } from "@/lib/watch-party-history-api";

/**
 * How "Transmissões anteriores" splits a channel's broadcasts into the rows
 * a moderator actually wants to scan and the ones that would just be noise
 * among them.
 *
 * TWO THINGS FOLD INTO "Gravações antigas", for two different reasons that
 * happen to want the same UI:
 *
 *  - `replayAvailable: false` -- the recording is gone (past retention, or
 *    never kept). Nothing to watch, so it earns no "Assistir" button and no
 *    keep-replay toggle either.
 *  - Under `SHORT_BROADCAST_SECONDS` -- a stormy party's egress restart
 *    shows up in `hls_sessions` as its own tiny broadcast (start, a few
 *    segments, end), which reads as "the party happened three times" rather
 *    than what it was: one party, one hiccup. `keep_replay` and
 *    `replayAvailable` say nothing about which of these this is, so it is
 *    judged on duration alone, independent of availability -- a short
 *    broadcast folds even if its segments are still there.
 *
 * Both land in the SAME accordion (an owner does not need two disclosures to
 * open before finding last night's stream), but keep distinct per-row labels
 * ("reinício" vs the existing "gravação não disponível" copy) so a restart
 * never reads as a broadcast that simply expired. A row that is both short
 * AND unavailable is labelled `"short"` -- "reinício" is the more useful fact
 * about it than "it's gone", which is true of every folded row eventually.
 *
 * A BROADCAST STILL LIVE (`endedAt === null`) NEVER FOLDS, whatever
 * `replayAvailable` says. It is never "old" -- it is happening right now --
 * and `replayAvailable` is unconditionally false for it (there is nothing to
 * replay yet), which would otherwise read exactly like an expired
 * recording's `"unavailable"` and land it in the very accordion literally
 * named "old". It stays in the main list, plain, with its own LIVE badge and
 * no controls (the same `replayAvailable` flag already keeps Watch and the
 * keep-replay toggle off it).
 *
 * Order is preserved within each bucket (the server already sorts newest
 * first); this only partitions, it never re-sorts.
 */
export const SHORT_BROADCAST_SECONDS = 60;

export type FoldedReason = "short" | "unavailable";

export interface FoldedWatchPartyHistoryEntry {
  entry: WatchPartyHistoryEntry;
  reason: FoldedReason;
}

export interface GroupedWatchPartyHistory {
  available: WatchPartyHistoryEntry[];
  folded: FoldedWatchPartyHistoryEntry[];
}

export function isShortBroadcast(entry: WatchPartyHistoryEntry): boolean {
  return (
    entry.durationSeconds !== null &&
    entry.durationSeconds < SHORT_BROADCAST_SECONDS
  );
}

export function groupWatchPartyHistory(
  broadcasts: WatchPartyHistoryEntry[],
): GroupedWatchPartyHistory {
  const available: WatchPartyHistoryEntry[] = [];
  const folded: FoldedWatchPartyHistoryEntry[] = [];
  for (const entry of broadcasts) {
    if (entry.endedAt === null) {
      available.push(entry);
      continue;
    }
    const short = isShortBroadcast(entry);
    if (!short && entry.replayAvailable) {
      available.push(entry);
      continue;
    }
    folded.push({ entry, reason: short ? "short" : "unavailable" });
  }
  return { available, folded };
}

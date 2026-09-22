/**
 * The decision half of `server/scripts/hls-reconcile-ll-prefixes.ts`: which
 * `mode = 'll'` rows point at an empty prefix, and which real prefix each one
 * should point at instead. Pure, so it is tested here and the script only
 * does the I/O.
 *
 * WHY ANY ROW IS WRONG. Until 2026-09-22 the API built an LL row's
 * `object_prefix` from its own `Date.now()` and pqp-remux wrote every object
 * under its own `time.Now()`, a few milliseconds later (24 ms on the
 * 2026-09-21 broadcast). The start request carries `startedAtMs` now, so new
 * rows match; every row before that names a prefix with nothing under it,
 * while the real objects sit next door under a timestamp nothing records.
 *
 * WHY REPOINTING ALSO TURNS `keep_replay` ON. A repointed row is suddenly a
 * row with objects under it. If it is past the short retention window with
 * `keep_replay` off, the very next sweep deletes the recording this script
 * was run to rescue; before the repoint the same sweep deleted nothing, by
 * accident. Kept rows get `LIVE_HLS_REPLAY_HOURS`, and a row already past
 * even that is refused rather than handed to the sweep.
 */

/** One `mode = 'll'` row as the script reads it. */
export interface LlPrefixRow {
  id: string;
  channelId: string;
  objectPrefix: string;
  startedAtMs: number;
  endedAtMs: number | null;
  cleaned: boolean;
  keepReplay: boolean;
}

export type LlPrefixPlan =
  | { kind: "ok"; row: LlPrefixRow }
  | { kind: "missing"; row: LlPrefixRow }
  | { kind: "ambiguous"; row: LlPrefixRow; candidates: string[] }
  | { kind: "taken"; row: LlPrefixRow; prefix: string }
  | { kind: "expired"; row: LlPrefixRow; prefix: string }
  | {
      kind: "repoint";
      row: LlPrefixRow;
      prefix: string;
      /** The row was marked cleaned by a sweep that deleted nothing. */
      revive: boolean;
    };

/** The `<startedAt>` of a `live/<channel>/<startedAt>-ll` prefix, or null. */
export function llPrefixStartedAt(prefix: string, channelId: string): number | null {
  const match = new RegExp(`^live/${channelId}/(\\d+)-ll/?$`).exec(prefix);
  return match ? Number(match[1]) : null;
}

/**
 * What to do with one row, given every LL directory the bucket has for its
 * channel (`live/<channel>/<startedAt>-ll`, no trailing slash) and every
 * `object_prefix` any row claims. The row's own may be in that set: a
 * candidate equal to it is answered "ok" before the set is consulted.
 */
export function planLlPrefixRepair(input: {
  row: LlPrefixRow;
  bucketPrefixes: readonly string[];
  claimedPrefixes: ReadonlySet<string>;
  windowMs: number;
  replayHours: number;
  now: number;
}): LlPrefixPlan {
  const { row } = input;
  if (input.bucketPrefixes.includes(row.objectPrefix)) {
    return { kind: "ok", row };
  }
  const candidates = input.bucketPrefixes.filter((prefix) => {
    const startedAt = llPrefixStartedAt(prefix, row.channelId);
    return (
      startedAt !== null && Math.abs(startedAt - row.startedAtMs) <= input.windowMs
    );
  });
  if (candidates.length === 0) {
    return { kind: "missing", row };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous", row, candidates };
  }
  const prefix = candidates[0]!;
  if (input.claimedPrefixes.has(prefix)) {
    return { kind: "taken", row, prefix };
  }
  if (
    row.endedAtMs !== null &&
    input.now - row.endedAtMs > input.replayHours * 60 * 60 * 1000
  ) {
    return { kind: "expired", row, prefix };
  }
  return { kind: "repoint", row, prefix, revive: row.cleaned };
}

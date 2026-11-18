/**
 * The unread strip's count and mentions, extended as messages arrive instead
 * of recounted from the first unread row on every arrival.
 *
 * The common change to the log is an append at the bottom. A tally is reused
 * only when no row it counted was rebuilt (`changedFrom`, the lowest index
 * whose row object is new: an edit, a delete, an older page above all
 * rebuild a row at or before it) and the mention rule (`maskKey`) is the
 * same. Then only the rows after it are scanned. Anything else recounts.
 */

interface TallyRow {
  message: { id: string; authorId: string };
}

export interface UnreadTally {
  firstId: string;
  maskKey: string;
  start: number;
  /** Rows counted so far, from index 0: the next scan starts here. */
  scanned: number;
  count: number;
  mentions: number;
}

export interface UnreadTallyInput {
  rows: readonly TallyRow[];
  mentionMask: readonly boolean[];
  firstId: string;
  selfId: string | null | undefined;
  /** The lowest index whose row was rebuilt since the last call. */
  changedFrom: number;
  /** What the mention mask was computed against (the viewer's names). */
  maskKey: string;
}

export function extendUnreadTally(
  prev: UnreadTally | null,
  { rows, mentionMask, firstId, selfId, changedFrom, maskKey }: UnreadTallyInput,
): UnreadTally | null {
  let start: number;
  let from: number;
  let count = 0;
  let mentions = 0;
  const reusable =
    prev !== null &&
    prev.firstId === firstId &&
    prev.maskKey === maskKey &&
    prev.scanned <= rows.length &&
    changedFrom >= prev.scanned &&
    rows[prev.start]?.message.id === firstId;
  if (reusable) {
    start = prev.start;
    from = prev.scanned;
    count = prev.count;
    mentions = prev.mentions;
  } else {
    start = rows.findIndex((row) => row.message.id === firstId);
    if (start < 0) {
      return null;
    }
    from = start;
  }
  for (let index = from; index < rows.length; index += 1) {
    if (rows[index].message.authorId === selfId) {
      continue;
    }
    count += 1;
    if (mentionMask[index]) {
      mentions += 1;
    }
  }
  return { firstId, maskKey, start, scanned: rows.length, count, mentions };
}

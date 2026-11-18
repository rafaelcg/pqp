/**
 * The unread strip's count and mentions, extended as messages arrive instead
 * of recounted from the first unread row on every arrival.
 *
 * The common change to the log is an append at the bottom. A tally is reused
 * when its first row and its last counted row are still the same row objects
 * at the same positions, and only the rows after it are scanned. Anything
 * else (an older page above, a delete, a replaced row at either end, a new
 * first unread) recounts from scratch. Row objects are reused for unchanged
 * messages, so an edited message is a new object.
 */

interface TallyRow {
  message: { id: string; authorId: string };
}

export interface UnreadTally {
  firstId: string;
  start: number;
  /** Rows counted so far, from index 0: the next scan starts here. */
  scanned: number;
  startRow: TallyRow;
  lastRow: TallyRow;
  count: number;
  mentions: number;
}

export function extendUnreadTally(
  prev: UnreadTally | null,
  rows: readonly TallyRow[],
  mentionMask: readonly boolean[],
  firstId: string,
  selfId: string | null | undefined,
): UnreadTally | null {
  let start: number;
  let from: number;
  let count = 0;
  let mentions = 0;
  const reusable =
    prev !== null &&
    prev.firstId === firstId &&
    prev.scanned <= rows.length &&
    rows[prev.start] === prev.startRow &&
    rows[prev.scanned - 1] === prev.lastRow;
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
  return {
    firstId,
    start,
    scanned: rows.length,
    startRow: rows[start],
    lastRow: rows[rows.length - 1],
    count,
    mentions,
  };
}

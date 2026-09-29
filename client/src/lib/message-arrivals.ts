/**
 * Sort the rows that just landed at the end of a transcript into the two
 * things the message list does with them.
 *
 * Only a message from somebody else is news. The "N new messages" pill and
 * the screen reader's heads-up used to count every appended row, so a reader
 * scrolled up in history who sent something was told they had one new
 * message, and it was theirs. A burst of their own sends read "25 new
 * messages".
 *
 * A send from this tab is the opposite of news: it is the reader asking to
 * see the bottom. An optimistic row is the proof. `pending` is only ever set
 * by this client's own `sendMessage` (and the outbox that replays it), so a
 * pending row by the reader is a send from here, while a settled row by the
 * reader arrived from another device and moves nothing.
 */

interface ArrivedRow {
  authorId: string;
  pending?: boolean;
}

export interface ArrivalSplit<Row extends ArrivedRow> {
  /** The reader just sent one of these from this tab. */
  sentHere: boolean;
  /** Rows by anybody else, oldest first: the only ones that count as new. */
  fromOthers: Row[];
}

export function splitArrivals<Row extends ArrivedRow>(
  arrived: readonly Row[],
  currentUserId: string | null,
): ArrivalSplit<Row> {
  let sentHere = false;
  const fromOthers: Row[] = [];
  for (const row of arrived) {
    if (currentUserId !== null && row.authorId === currentUserId) {
      if (row.pending) {
        sentHere = true;
      }
      continue;
    }
    fromOthers.push(row);
  }
  return { sentHere, fromOthers };
}

/**
 * THE QUEUE OF RAISED HANDS, DERIVED THE SAME WAY EVERYWHERE.
 *
 * The wire carries one number per person (`voiceParticipantSchema.handRaisedAt`)
 * and no list. This file is the list: the single ordering rule that the call
 * stage, the sidebar and the server's own tests all run, so "who is third"
 * cannot come out differently on two screens looking at the same roster.
 *
 * The rule is: hand up first, oldest raise first, ties broken on `userId`.
 * The tie-break is not decoration. Two `INSERT`s inside the same millisecond
 * are perfectly ordinary on one Postgres, and without a total order the two
 * clients that receive that roster would each sort them however their engine
 * felt like, which is exactly the disagreement the server-stamped timestamp
 * exists to prevent.
 */

/** The shape this file needs: a roster participant, or anything shaped like one. */
export interface RaisedHandPerson {
  userId: string;
  handRaisedAt?: number | null;
}

/**
 * How many hands the call stage prints before it collapses the rest into a
 * count.
 *
 * THE QUEUE ITSELF IS NOT CAPPED, and that is deliberate. Refusing the
 * twenty-first hand takes away the only way that person has to say "me next"
 * and buys nothing: the state is one flag per person, so the queue is already
 * bounded by how many people are in the room, and the room has its own
 * ceiling. What a 130-person community actually cannot use is a list of forty
 * names, so the LIST is what gets cut, never the queue. Everybody is still
 * told their own position however far back it is (`raisedHandPosition`), which
 * is the fact they wanted in the first place.
 */
export const RAISED_HAND_LIST_LIMIT = 5;

/**
 * The room's hands, in the order they went up.
 *
 * One entry per PERSON, not per seat: somebody in the call on a laptop and a
 * phone holds two roster entries carrying the same hand, and printing them
 * twice would make the queue lie about its own length. The earlier seat wins,
 * which after the sort is the first one seen.
 */
export function raisedHandQueue<T extends RaisedHandPerson>(
  participants: readonly T[],
): T[] {
  const raised = participants.filter(
    (person) =>
      person.handRaisedAt !== null && person.handRaisedAt !== undefined,
  );
  raised.sort((a, b) => {
    const at = a.handRaisedAt ?? 0;
    const bt = b.handRaisedAt ?? 0;
    if (at !== bt) {
      return at - bt;
    }
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const seen = new Set<string>();
  return raised.filter((person) => {
    if (seen.has(person.userId)) {
      return false;
    }
    seen.add(person.userId);
    return true;
  });
}

/**
 * Where one person stands in that queue, 1-based, or null when their hand is
 * down. "You are third" is the useful sentence; this is the number in it.
 */
export function raisedHandPosition(
  participants: readonly RaisedHandPerson[],
  userId: string,
): number | null {
  const index = raisedHandQueue(participants).findIndex(
    (person) => person.userId === userId,
  );
  return index === -1 ? null : index + 1;
}

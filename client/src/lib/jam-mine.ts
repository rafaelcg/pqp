import type { JamPublicMyPart } from "@pqp/shared";

/**
 * "Tuas músicas": the words and the order of the one place a returning person
 * sees what became of what they made (user test round 3, N-3). Pure, so the
 * rules are tested without a screen.
 *
 * Two lists. The songs they STARTED (`GET /api/jam-public/mine`), each with the
 * parts still waiting for their answer, and the parts they SENT to other
 * people's songs (`GET /api/jam-public/my-parts`), each in one of three states:
 * waiting, in, refused. Nothing here is a notice: a notice is spent when it is
 * tapped, this is what is true for as long as the song and the part exist.
 */

/** The catalogue key and the name slot for one sent part's state line. */
export function minePartState(part: Pick<JamPublicMyPart, "state" | "startedBy">): {
  key: "jam.mine.state.waiting" | "jam.mine.state.waitingAnon" | "jam.mine.state.in" | "jam.mine.state.refused" | "jam.mine.state.refusedAnon";
  name: string | null;
} {
  const name = part.startedBy?.trim() ? part.startedBy.trim() : null;
  switch (part.state) {
    case "in":
      return { key: "jam.mine.state.in", name: null };
    case "refused":
      return name ? { key: "jam.mine.state.refused", name } : { key: "jam.mine.state.refusedAnon", name: null };
    default:
      return name ? { key: "jam.mine.state.waiting", name } : { key: "jam.mine.state.waitingAnon", name: null };
  }
}

/** How many parts wait for the person's answer on a song they started. */
export function waitingOn(songId: string, inbox: ReadonlyArray<{ songId: string }>): number {
  return inbox.filter((one) => one.songId === songId).length;
}

/**
 * The parts to draw, open ones first: a part still waiting is the one a person
 * came back to check, and a refusal is read once. Within a state the server's
 * order (newest first) is kept.
 */
export function orderMineParts<T extends Pick<JamPublicMyPart, "state">>(parts: readonly T[]): T[] {
  const rank = (state: JamPublicMyPart["state"]) => (state === "waiting" ? 0 : state === "in" ? 1 : 2);
  return parts
    .map((part, index) => ({ part, index }))
    .sort((a, b) => rank(a.part.state) - rank(b.part.state) || a.index - b.index)
    .map(({ part }) => part);
}

/** Nothing to show: the person has not started a public song and has not sent a part. */
export function mineIsEmpty(started: readonly unknown[], parts: readonly unknown[]): boolean {
  return started.length === 0 && parts.length === 0;
}

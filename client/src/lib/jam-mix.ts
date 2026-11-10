import type { JamTrack } from "@pqp/shared";

/**
 * Putting a take in the mix is a swap. The server lets several takes of one
 * instrument be `inMix` at once (nothing stops it), and a song with two guitars
 * both playing is almost never what somebody meant by "use this one". So the
 * screens treat the mix as one take per instrument: using a take takes the
 * others of its instrument out.
 */

/** The ids to take out when `trackId` is put in: every other in-mix take of its instrument. */
export function takesToTakeOut(tracks: readonly JamTrack[], trackId: string): string[] {
  const chosen = tracks.find((track) => track.id === trackId);
  if (!chosen) {
    return [];
  }
  return tracks
    .filter((track) => track.id !== chosen.id && track.instrument === chosen.instrument && track.inMix)
    .map((track) => track.id);
}

/**
 * The take a new recording would replace: the poster's own take of the same
 * instrument that is in the mix right now. Only a person who may switch the mix
 * (the song's author or a moderator) can be asked, because only they can act on
 * the answer.
 */
export function takeToReplace(
  tracks: readonly JamTrack[],
  input: { instrument: JamTrack["instrument"]; viewerId: string | null; canSwitchMix: boolean },
): JamTrack | null {
  if (!input.canSwitchMix || input.viewerId === null) {
    return null;
  }
  return (
    tracks.find(
      (track) => track.inMix && track.instrument === input.instrument && track.authorId === input.viewerId,
    ) ?? null
  );
}

/**
 * Runs one thing at a time: a call made while another is running is dropped and
 * answers `undefined`. Two quick taps on competing takes would otherwise each
 * read the same snapshot of the mix and leave both of them in.
 */
export function oneAtATime(): <T>(run: () => Promise<T>) => Promise<T | undefined> {
  let busy = false;
  return async (run) => {
    if (busy) {
      return undefined;
    }
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  };
}

/**
 * "Usar este take": this one in first, then the others of its instrument out,
 * together and read from `latest()` AFTER the first write (so a frame that
 * arrived meanwhile counts). Resolves `partial` when a take-out failed: the
 * instrument is then playing twice, which is told and never silent.
 */
export async function switchTakeIn(
  trackId: string,
  put: (id: string, inMix: boolean) => Promise<void>,
  latest: () => readonly JamTrack[],
): Promise<"swapped" | "partial"> {
  await put(trackId, true);
  const outcomes = await Promise.allSettled(takesToTakeOut(latest(), trackId).map((id) => put(id, false)));
  return outcomes.some((outcome) => outcome.status === "rejected") ? "partial" : "swapped";
}

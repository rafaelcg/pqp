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

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

/** Reads the song's tracks from the server again (`null` when that fails too). */
export type RereadMix = () => Promise<readonly JamTrack[] | null>;

/**
 * A new take replacing the poster's old one in the mix: the new one in, then the
 * old one out.
 *
 * A write that throws is NOT known to have failed (the server may have applied it
 * and the reply been lost), so after any failure the mix is READ AGAIN and the
 * next step is decided from what it really is: new out, old in is the start;
 * new in, old in takes the old one out; neither in puts the new one in. A few
 * rounds of that, then the half-done case is undone: the new take goes back out
 * and the old one stays (`kept-old`, told, and the person may use the new take by
 * hand). `both` is for a mix that could not be read or put right.
 */
export async function replaceInMix(
  newId: string,
  oldId: string,
  put: (id: string, inMix: boolean) => Promise<void>,
  reread: RereadMix,
): Promise<"replaced" | "kept-old" | "both"> {
  type State = { newIn: boolean; oldIn: boolean };
  const observe = async (): Promise<State | null> => {
    const tracks = await reread();
    const fresh = tracks?.find((track) => track.id === newId);
    const old = tracks?.find((track) => track.id === oldId);
    return tracks && fresh ? { newIn: fresh.inMix, oldIn: old?.inMix ?? false } : null;
  };
  let state: State = { newIn: false, oldIn: true };
  for (let round = 0; round < 4; round++) {
    if (state.newIn && !state.oldIn) {
      return "replaced";
    }
    try {
      if (!state.newIn) {
        await put(newId, true);
        state = { ...state, newIn: true };
      } else {
        await put(oldId, false);
        state = { ...state, oldIn: false };
      }
    } catch {
      const seen = await observe();
      if (!seen) {
        return "both"; // the mix cannot be read: do not guess
      }
      state = seen;
    }
  }
  if (state.newIn && !state.oldIn) {
    return "replaced";
  }
  // Out of rounds: undo the half, so the mix is the one it was.
  if (state.newIn) {
    try {
      await put(newId, false);
      state = { ...state, newIn: false };
    } catch {
      state = (await observe()) ?? state;
    }
  }
  if (!state.newIn && state.oldIn) {
    return "kept-old";
  }
  if (!state.newIn && !state.oldIn) {
    try {
      await put(oldId, true);
      return "kept-old";
    } catch {
      return "both";
    }
  }
  return "both";
}

/**
 * "Usar este take": this one in first, then the others of its instrument out,
 * together and read from `latest()` AFTER the first write (so a frame that
 * arrived meanwhile counts). A write that throws is checked against a fresh read
 * of the mix before it is believed: the first write may have landed, a take-out
 * that threw is retried once if it is still in. `partial` is only what is still
 * in the mix after that, told and never silent.
 */
export async function switchTakeIn(
  trackId: string,
  put: (id: string, inMix: boolean) => Promise<void>,
  latest: () => readonly JamTrack[],
  reread: RereadMix,
): Promise<"swapped" | "partial"> {
  try {
    await put(trackId, true);
  } catch (failure) {
    const tracks = await reread();
    if (!tracks?.find((track) => track.id === trackId)?.inMix) {
      throw failure; // it did not land
    }
  }
  const outcomes = await Promise.allSettled(takesToTakeOut(latest(), trackId).map((id) => put(id, false)));
  if (!outcomes.some((outcome) => outcome.status === "rejected")) {
    return "swapped";
  }
  let remaining = takesToTakeOut((await reread()) ?? latest(), trackId);
  if (remaining.length > 0) {
    await Promise.allSettled(remaining.map((id) => put(id, false)));
    remaining = takesToTakeOut((await reread()) ?? latest(), trackId);
  }
  return remaining.length === 0 ? "swapped" : "partial";
}


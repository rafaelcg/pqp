/**
 * "to fora da call e só na watch pq tava duplicado" (postmortem C4).
 *
 * A person can watch a channel's HLS stream without joining its call at all
 * (`WatchStage`), which is the whole point of the egress. If they ALSO hold a
 * seat in that same call right now, from a phone, a second tab, another
 * browser profile, they hear themselves twice: once live through whichever
 * device is seated, once ~25s behind through the transcode this device is
 * playing. Nothing about that is visible from inside either device on its
 * own, so the client has to notice it.
 *
 * The two facts it takes are both already on hand. `voiceState.occupancy`
 * is broadcast for every voice channel on the server, not just the one this
 * socket joined — it is what already lights up a "3 in voice" badge on a
 * channel nobody here has entered — so it already carries a seat some OTHER
 * device is holding. And the client always knows its own account's user id.
 * The only new idea is comparing the two.
 */

/** The one field this needs from a roster entry (`VoiceParticipant.userId`). */
export interface SeatedPerson {
  userId: string;
}

/**
 * True when the signed-in account holds a seat in this channel's call right
 * now, on some device or tab OTHER than the one asking.
 *
 * `inThisCall` is the escape hatch: a device that is itself seated already
 * hides its own watch stage (`WatchStage`'s `inThisCall` gate) rather than
 * show a stream beside the call, so this only has to fire for the surprising
 * case — a *different* connection holding the seat this one is not in.
 */
export function isSeatedOnAnotherDevice(
  occupants: readonly SeatedPerson[] | undefined,
  meUserId: string | null,
  inThisCall: boolean,
): boolean {
  if (inThisCall || !meUserId || !occupants || occupants.length === 0) {
    return false;
  }
  return occupants.some((person) => person.userId === meUserId);
}

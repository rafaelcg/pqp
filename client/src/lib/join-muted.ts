/**
 * Whether a voice join should start with the mic muted.
 *
 * The user's own "mute mic when joining" setting always wins. On top of it,
 * a room that already holds a crowd is joined muted regardless: on
 * 2026-09-05 a streamer's 100-person watch party spent the evening asking
 * newcomers to mute, because every phone that joined came in hot. Nobody
 * walks into a cinema talking. The person can unmute the moment they want
 * to; this only decides the first second. The server-side lock (the SPEAK
 * permission) is a separate change; this is the client's part and ships
 * without an API restart.
 */
export const LARGE_ROOM_JOIN_MUTED_THRESHOLD = 10;

export function shouldJoinMuted(
  muteOnJoinPreference: boolean,
  occupantsAlreadyInRoom: number,
): boolean {
  if (muteOnJoinPreference) {
    return true;
  }
  return occupantsAlreadyInRoom >= LARGE_ROOM_JOIN_MUTED_THRESHOLD;
}

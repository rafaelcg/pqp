import {
  CAMERA_LIMIT,
  SCREEN_SHARE_LIMIT,
  type VoiceRoomTransport,
} from "@pqp/shared";

/**
 * Who to put in the large tile after a roster snapshot.
 *
 * The wire has no share-start timestamp. "Newest" is a diff against the
 * previous set. An empty previous set is a join into a room that already has
 * shares: pick the first roster id, matching what old clients did with `.find()`.
 * A focused id that disappeared (stop or disconnect) falls back to the last
 * remaining id, same path for both.
 */
export function nextScreenShareFocus(
  previousIds: readonly string[],
  nextIds: readonly string[],
  previousFocus: string | null,
): string | null {
  if (nextIds.length === 0) {
    return null;
  }
  if (previousIds.length === 0) {
    return nextIds[0]!;
  }
  const previous = new Set(previousIds);
  const newcomers = nextIds.filter((id) => !previous.has(id));
  if (newcomers.length > 0) {
    return newcomers[newcomers.length - 1]!;
  }
  if (previousFocus && nextIds.includes(previousFocus)) {
    return previousFocus;
  }
  return nextIds[nextIds.length - 1]!;
}

/**
 * Whose system audio to play. Independent of whether the stage is mounted:
 * leaving the voice-channel view must not mute a live share.
 *
 * 0: none. 1: that share. 2: both (desktop split and phone alike). 3+: focused
 * only, so thumbnail shares stay silent.
 */
export function audibleScreenPeerIds(
  ids: readonly string[],
  focused: string | null,
): string[] {
  if (ids.length <= 2) {
    return [...ids];
  }
  if (focused && ids.includes(focused)) {
    return [focused];
  }
  return ids.slice(0, 1);
}

/**
 * True when someone else already fills every slot, so we must not open the
 * picker.
 *
 * `canPromote` is `VoiceState.canPromoteTransport`: a mesh room on a
 * deployment that has a voice server to move it to. On such a room the caps
 * here are not the answer, because hitting them is what asks the server to
 * move the room (see the promotion section in `server/src/ws/voice.ts`).
 * Refusing locally is what made the mesh cap feel like a wall: the claim never
 * reached the server, so the server never got the chance to lift it. The
 * server still refuses when it cannot promote, and the client still says so.
 */
export function isScreenShareAtCap(
  sharingPeerIds: readonly string[],
  localPeerId: string | null,
  transport: VoiceRoomTransport | null,
  canPromote = false,
): boolean {
  if (canPromote && (transport ?? "mesh") === "mesh") {
    return false;
  }
  const others = sharingPeerIds.filter((id) => id !== localPeerId).length;
  return others >= SCREEN_SHARE_LIMIT[transport ?? "mesh"];
}

/**
 * Same shape as the screen-share cap, for cameras, with one difference that
 * is the whole point of it.
 *
 * `CAMERA_LIMIT.livekit` is `null`: on the voice server there is no headcount
 * to be at. Whether one more camera fits is a question about the box's egress
 * and only the server can answer it (`server/src/voice/promotion.ts`), so the
 * client never greys the button there. A refusal comes back as
 * `camera-denied` and is said in words, which is the same shape as the mesh
 * room that could not be promoted.
 */
export function isCameraAtCap(
  cameraPeerIds: readonly string[],
  localPeerId: string | null,
  transport: VoiceRoomTransport | null,
  canPromote = false,
): boolean {
  if (canPromote && (transport ?? "mesh") === "mesh") {
    return false;
  }
  const limit = CAMERA_LIMIT[transport ?? "mesh"];
  if (limit === null) {
    return false;
  }
  const others = cameraPeerIds.filter((id) => id !== localPeerId).length;
  return others >= limit;
}

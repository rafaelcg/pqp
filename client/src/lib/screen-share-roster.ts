import { SCREEN_SHARE_LIMIT, type VoiceRoomTransport } from "@pqp/shared";

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

/** True when someone else already fills every slot, so we must not open the picker. */
export function isScreenShareAtCap(
  sharingPeerIds: readonly string[],
  localPeerId: string | null,
  transport: VoiceRoomTransport | null,
): boolean {
  const others = sharingPeerIds.filter((id) => id !== localPeerId).length;
  return others >= SCREEN_SHARE_LIMIT[transport ?? "mesh"];
}

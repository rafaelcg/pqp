import {
  CAMERA_LIMIT,
  SCREEN_SHARE_LIMIT,
  meshVideoLimit,
  type MeshVideoKind,
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
  room?: MeshRoomLink,
): boolean {
  return isVideoAtCap(
    "screens",
    sharingPeerIds,
    localPeerId,
    transport,
    canPromote,
    room,
  );
}

/**
 * What the mesh limit needs to know about this room to be computed at all.
 *
 * Optional at every call site, and absent reads as "unmeasured", which is the
 * old constant. The client's number is only ever a prediction of the server's:
 * the server holds every seat's report and takes the narrowest, so a client
 * that greys its own button early is showing the truth about ITS link, and one
 * that does not grey it gets an honest refusal in words. The enforcement is
 * the server's alone.
 */
export interface MeshRoomLink {
  /** Seats in the call, this machine included. */
  roomSize: number;
  /** This machine's measured uplink in bit/s, or null before it has one. */
  uplinkBps: number | null;
}

function localLimit(
  kind: MeshVideoKind,
  transport: VoiceRoomTransport | null,
  room: MeshRoomLink | undefined,
): number | null {
  if ((transport ?? "mesh") !== "mesh") {
    return kind === "screens" ? SCREEN_SHARE_LIMIT.livekit : CAMERA_LIMIT.livekit;
  }
  return meshVideoLimit({
    kind,
    roomSize: room?.roomSize ?? 0,
    uplinkBps: room?.uplinkBps ?? null,
  });
}

function isVideoAtCap(
  kind: MeshVideoKind,
  publisherPeerIds: readonly string[],
  localPeerId: string | null,
  transport: VoiceRoomTransport | null,
  canPromote: boolean,
  room: MeshRoomLink | undefined,
): boolean {
  if (canPromote && (transport ?? "mesh") === "mesh") {
    return false;
  }
  const limit = localLimit(kind, transport, room);
  if (limit === null) {
    return false;
  }
  const others = publisherPeerIds.filter((id) => id !== localPeerId).length;
  return others >= limit;
}

/**
 * Same shape as the screen-share cap, for cameras, with one difference that
 * is the whole point of it.
 *
 * `CAMERA_LIMIT.livekit` and `SCREEN_SHARE_LIMIT.livekit` are both `null`: on
 * the voice server there is no headcount to be at. Whether one more camera fits is a question about the box's egress
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
  room?: MeshRoomLink,
): boolean {
  return isVideoAtCap(
    "cameras",
    cameraPeerIds,
    localPeerId,
    transport,
    canPromote,
    room,
  );
}

/**
 * The room's link, read off whatever carries the voice state.
 *
 * Typed structurally rather than against `VoiceState` so this module stays
 * free of the hook (the hook imports it, not the other way round).
 */
export function meshRoomLinkOf(state: {
  remotePeers: readonly unknown[];
  uplinkBps: number | null;
}): MeshRoomLink {
  return {
    roomSize: state.remotePeers.length + 1,
    uplinkBps: state.uplinkBps,
  };
}

/**
 * The number to show beside a greyed-out button, or null when there is no
 * number to show because the answer is the box's rather than a count.
 */
export function videoLimitOf(
  state: {
    remotePeers: readonly unknown[];
    uplinkBps: number | null;
    roomTransport: VoiceRoomTransport | null;
  },
  kind: MeshVideoKind,
): number | null {
  return localLimit(kind, state.roomTransport, meshRoomLinkOf(state));
}

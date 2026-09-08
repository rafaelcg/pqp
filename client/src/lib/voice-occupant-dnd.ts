import {
  Permission,
  type ChannelType,
  type VoiceParticipant,
} from "@pqp/shared";

/**
 * Dragging people between voice channels, Discord-style.
 *
 * Self-move is an ordinary join: the voice-move API refuses self-targeting
 * ("Use the leave button on yourself"). Staff moving someone else is the
 * existing `POST .../voice-move` path, gated on MOVE_MEMBERS.
 */
export function moveMembersBit(): bigint {
  return Permission.MOVE_MEMBERS;
}

export const VOICE_OCCUPANT_DRAG_MIME = "application/x-pqp-voice-occupant";

export type VoiceOccupantDrag = {
  userId: string;
  fromChannelId: string;
  isSelf: boolean;
};

/** Anything that is not text or a category is a voice room (`watch_party` too). */
export type VoiceDropTarget = {
  id: string;
  type: ChannelType;
};

export type VoiceDropCaps = {
  canMoveIn: (channelId: string) => boolean;
  canConnectIn: (channelId: string) => boolean;
};

export type VoiceDropReason =
  | "text"
  | "category"
  | "same"
  | "no-move"
  | "no-connect";

export type VoiceDropResult =
  | { ok: true; action: "join" | "move" }
  | { ok: false; reason: VoiceDropReason };

export function canDragVoiceOccupant(
  isSelf: boolean,
  fromChannelId: string,
  canMoveIn: (channelId: string) => boolean,
): boolean {
  return isSelf || canMoveIn(fromChannelId);
}

export function resolveVoiceOccupantDrop(
  drag: VoiceOccupantDrag,
  target: VoiceDropTarget,
  caps: VoiceDropCaps,
): VoiceDropResult {
  if (target.type === "text") {
    return { ok: false, reason: "text" };
  }
  if (target.type === "category") {
    return { ok: false, reason: "category" };
  }
  if (target.id === drag.fromChannelId) {
    return { ok: false, reason: "same" };
  }
  if (drag.isSelf) {
    if (!caps.canConnectIn(target.id)) {
      return { ok: false, reason: "no-connect" };
    }
    return { ok: true, action: "join" };
  }
  if (!caps.canMoveIn(drag.fromChannelId)) {
    return { ok: false, reason: "no-move" };
  }
  return { ok: true, action: "move" };
}

export function shouldHighlightVoiceDrop(
  drag: VoiceOccupantDrag | null,
  target: VoiceDropTarget,
  caps: VoiceDropCaps,
): boolean {
  if (!drag) {
    return false;
  }
  return resolveVoiceOccupantDrop(drag, target, caps).ok;
}

export type VoiceOccupantMenuAction =
  | "profile"
  | "muteForMe"
  | "unmuteForMe"
  | "lowerHand"
  | "serverMute"
  | "serverUnmute"
  | "disconnect"
  | "kick"
  | "copyName";

/**
 * Right-click actions that already exist elsewhere. No ban/timeout (those
 * live on the profile card and members panel). No promote/demote (cargos
 * replaced them). No server deafen (there is no API).
 */
export function voiceOccupantMenuActions(input: {
  isSelf: boolean;
  inSameCall: boolean;
  mutedForMe: boolean;
  canServerMute: boolean;
  serverMuted: boolean;
  /** This person's hand is up: `handRaisedAt` on their roster entry. */
  handRaised?: boolean;
  canDisconnect: boolean;
  canKick: boolean;
}): VoiceOccupantMenuAction[] {
  const items: VoiceOccupantMenuAction[] = ["profile"];
  if (!input.isSelf && input.inSameCall) {
    items.push(input.mutedForMe ? "unmuteForMe" : "muteForMe");
  }
  // "You're up." Offered only while the hand is actually up, and on the same
  // bit as the mute, because it is the same job: running the room. It lives
  // here as well as on the call stage because an audio-only call has no
  // expanded stage to put a queue on, and the sidebar is where that room's
  // people are listed anyway.
  if (!input.isSelf && input.canServerMute && input.handRaised) {
    items.push("lowerHand");
  }
  if (!input.isSelf && input.canServerMute) {
    items.push(input.serverMuted ? "serverUnmute" : "serverMute");
  }
  if (!input.isSelf && input.canDisconnect) {
    items.push("disconnect");
  }
  if (!input.isSelf && input.canKick) {
    items.push("kick");
  }
  items.push("copyName");
  return items;
}

export function cloneVoiceOccupancy(
  occupancy: Record<string, VoiceParticipant[]>,
): Record<string, VoiceParticipant[]> {
  const next: Record<string, VoiceParticipant[]> = {};
  for (const [channelId, people] of Object.entries(occupancy)) {
    next[channelId] = [...people];
  }
  return next;
}

/**
 * Move one seated person onto another voice channel in the local roster.
 * Used for the optimistic seat (paint now, rollback if the move fails).
 */
export function moveOccupantSeat(
  occupancy: Record<string, VoiceParticipant[]>,
  userId: string,
  toChannelId: string,
): {
  next: Record<string, VoiceParticipant[]>;
  fromChannelId: string | null;
  moved: VoiceParticipant | null;
} {
  const next = cloneVoiceOccupancy(occupancy);
  let fromChannelId: string | null = null;
  let moved: VoiceParticipant | null = null;
  for (const [channelId, people] of Object.entries(next)) {
    const index = people.findIndex((person) => person.userId === userId);
    if (index === -1) {
      continue;
    }
    moved = people[index]!;
    fromChannelId = channelId;
    people.splice(index, 1);
    if (people.length === 0) {
      delete next[channelId];
    }
    break;
  }
  if (!moved || fromChannelId === toChannelId) {
    return { next: occupancy, fromChannelId, moved };
  }
  next[toChannelId] = [...(next[toChannelId] ?? []), moved];
  return { next, fromChannelId, moved };
}

export function dropReasonMessageKey(
  reason: VoiceDropReason,
):
  | "voice.occupant.dropText"
  | "voice.occupant.dropNoMove"
  | "voice.occupant.dropNoConnect"
  | "voice.occupant.dropSame" {
  switch (reason) {
    case "text":
    case "category":
      return "voice.occupant.dropText";
    case "no-move":
      return "voice.occupant.dropNoMove";
    case "no-connect":
      return "voice.occupant.dropNoConnect";
    case "same":
      return "voice.occupant.dropSame";
  }
}

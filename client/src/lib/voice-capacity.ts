import {
  CAMERA_LIMIT,
  MESH_VOICE_LIMIT,
  SCREEN_SHARE_LIMIT,
  type VoiceRoomTransport,
} from "@pqp/shared";
import { isHintSeen, rememberHint, shouldPersistHints } from "./hints";
import { translateMessage } from "./i18n";

/**
 * "Agora cabe mais gente": the one line a call gets when its limits go up.
 *
 * A room's transport is the server's decision and it can change under the
 * people already sitting in the call: a fourth camera, a third share, a ninth
 * person at the door, a stale pin. When it does, the room quietly gains
 * headroom and nobody is told, so the person who was refused a screen share a
 * minute ago never tries again. Two production servers were moved by hand for
 * exactly this reason.
 *
 * The trigger here is the CAPABILITY, never the transport's name. Nobody in a
 * call cares whether their audio is going peer to peer or through a box in São
 * Paulo; they care that four screens fit now and three did not. So this module
 * reads both limit maps, compares the before and the after, and says nothing
 * at all when the numbers did not actually move.
 *
 * Every number in the sentence is read out of the shared maps rather than
 * written into the copy, so the wording cannot drift from the code that
 * enforces it.
 */

/** A limit, or `null` when the room has no number worth naming. */
export type CapacityCount = number | null;

export interface RoomCapacity {
  /** Seats. */
  people: CapacityCount;
  /** Screen shares at the same time. */
  screens: CapacityCount;
  /** Cameras at the same time. */
  cameras: CapacityCount;
}

/**
 * What one transport lets a room do.
 *
 * The casts are deliberate rather than sloppy. `CAMERA_LIMIT.livekit` is a
 * number today and is on its way to `null` (on the voice server the ceiling is
 * the box's egress, which only the server can price, so there is no headcount
 * to state). Widening to `number | null` here is legal from either shape,
 * whereas a `=== null` test written against a bare `number` is a type error.
 * That keeps this file correct across that change instead of on one side of it.
 *
 * `people` is the same story from the other end: the mesh has a seat count of
 * its own (`MESH_VOICE_LIMIT`), the voice server does not, so the honest answer
 * there is "no number", not a number we invented.
 */
export function roomCapacity(transport: VoiceRoomTransport): RoomCapacity {
  return {
    people: transport === "mesh" ? (MESH_VOICE_LIMIT as CapacityCount) : null,
    screens: SCREEN_SHARE_LIMIT[transport] as CapacityCount,
    cameras: CAMERA_LIMIT[transport] as CapacityCount,
  };
}

/**
 * Did this one limit go up?
 *
 * `null` is uncapped, so it beats every number, and no number beats it. Going
 * from uncapped to a number is a fall, not a rise, and must stay silent.
 */
function grew(before: CapacityCount, after: CapacityCount): boolean {
  if (before === after) {
    return false;
  }
  if (after === null) {
    return true;
  }
  if (before === null) {
    return false;
  }
  return after > before;
}

/** True when anything the person can see got bigger. */
export function capacityRose(before: RoomCapacity, after: RoomCapacity): boolean {
  return (
    grew(before.people, after.people) ||
    grew(before.screens, after.screens) ||
    grew(before.cameras, after.cameras)
  );
}

/**
 * The new capacity, when moving from `before` to `after` raised it. Null
 * otherwise, which covers the two cases that must stay quiet: a room whose
 * transport never changed, and a person who has no `before` at all because
 * they walked into the room after the change.
 */
export function capacityRiseBetween(
  before: VoiceRoomTransport | null,
  after: VoiceRoomTransport | null,
): RoomCapacity | null {
  if (!before || !after) {
    return null;
  }
  // Deliberately no `before === after` shortcut. The only question this
  // module answers is whether the numbers went up, so two identical
  // transports fall out of the comparison for the same reason a transport
  // change that gained nothing does: nothing grew.
  const next = roomCapacity(after);
  return capacityRose(roomCapacity(before), next) ? next : null;
}

/**
 * The sentence, in the words of the person in the call: more people, more
 * screens at once, cameras.
 *
 * Three shapes because a slot that receives `null` renders the word "null" on
 * somebody's screen. Whichever limits this room can name, it names; the ones it
 * cannot are said in words instead.
 *
 * Resolved through the catalogue on every call rather than captured in a
 * module constant, for the same reason as `components/voice/capabilities.ts`:
 * a constant is evaluated at import time, before the pt-BR chunk has loaded,
 * and would pin the line to English for the rest of the session.
 */
export function capacityNoticeMessage(capacity: RoomCapacity): string {
  if (capacity.screens === null) {
    return translateMessage("voice.capacity.bodyOpen");
  }
  if (capacity.cameras === null) {
    return translateMessage("voice.capacity.bodyCameras", {
      screens: capacity.screens,
    });
  }
  return translateMessage("voice.capacity.body", {
    screens: capacity.screens,
    cameras: capacity.cameras,
  });
}

/**
 * Once per person per room. The key carries the voice channel id because the
 * thing that changed is that room, and a person who has seen it there has seen
 * it: coming back tomorrow must not show it again.
 */
export function voiceCapacityHintKey(voiceChannelId: string): string {
  return `pqp:voice-capacity-${voiceChannelId}`;
}

export function isVoiceCapacityHintSeen(
  voiceChannelId: string,
  storage?: Pick<Storage, "getItem"> | null,
  persist: boolean = shouldPersistHints(),
): boolean {
  return isHintSeen(voiceCapacityHintKey(voiceChannelId), storage, persist);
}

export function rememberVoiceCapacityHint(
  voiceChannelId: string,
  storage?: Pick<Storage, "setItem"> | null,
  persist: boolean = shouldPersistHints(),
): void {
  rememberHint(voiceCapacityHintKey(voiceChannelId), storage, persist);
}

/**
 * Show the card? Pure, so the "once, and never again in this room" rule is a
 * test rather than a thing you find out in production.
 */
export function shouldShowCapacityNotice(input: {
  rise: RoomCapacity | null;
  seen: boolean;
  automated: boolean;
}): boolean {
  return input.rise !== null && !input.seen && !input.automated;
}

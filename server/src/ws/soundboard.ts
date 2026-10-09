import {
  SOUNDBOARD_MAX_DURATION_MS,
  SOUNDBOARD_ROOM_CONCURRENCY,
} from "@pqp/shared";

/**
 * How many clips one person may have sounding at once. Without it a single
 * seated member holds every room slot with 5 s clips and silences the rest.
 */
export const SOUNDBOARD_USER_CONCURRENCY = 3;

/**
 * Who may start a clip, and how many may be sounding.
 *
 * The seat check (are you in this room) stays in `voice.ts`, which already
 * holds the peer. This module is the rest: the bit, a moderator mute, and
 * the overlap cap. A refused play is silence. Nothing is stored.
 *
 * The caps are per process, but a play the other machine admitted is noted
 * here too (`noteRemoteSoundboardPlay`, from the cluster frame), so each
 * machine's count follows the whole room and the cap holds across `api-a` and
 * `api-b` up to a frame's travel time. A shared counter would be a database
 * write on every click.
 */

export interface SoundboardPlayGate {
  /** Resolved `USE_SOUNDBOARD`. False in a DM. */
  canUseSoundboard: boolean;
  /** Moderator mute. Self-mute does not belong here. */
  serverMuted: boolean;
  /** The frame's channel is the seat's channel. */
  channelMatches: boolean;
}

export function soundboardPlayAllowed(gate: SoundboardPlayGate): boolean {
  return gate.canUseSoundboard && !gate.serverMuted && gate.channelMatches;
}

interface ActivePlay {
  userId: string;
  endsAt: number;
}

const active = new Map<string, ActivePlay[]>();

export function resetSoundboardPlays(): void {
  active.clear();
}

function livePlays(channelId: string, now: number): ActivePlay[] {
  const plays = (active.get(channelId) ?? []).filter((play) => play.endsAt > now);
  if (plays.length === 0) {
    active.delete(channelId);
  } else {
    active.set(channelId, plays);
  }
  return plays;
}

/**
 * True when this room is at the overlap cap, or (with `userId`) when this
 * person already has `SOUNDBOARD_USER_CONCURRENCY` clips sounding.
 */
export function soundboardRoomFull(
  channelId: string,
  now = Date.now(),
  userId?: string,
): boolean {
  const plays = livePlays(channelId, now);
  if (plays.length >= SOUNDBOARD_ROOM_CONCURRENCY) {
    return true;
  }
  return (
    userId !== undefined &&
    plays.filter((play) => play.userId === userId).length >=
      SOUNDBOARD_USER_CONCURRENCY
  );
}

/**
 * Count a play another machine admitted. Never refuses: the sender already
 * did, and its listeners hear it either way. It only makes this machine's
 * next local offer see the same room. The cluster frame carries the clip's
 * length; an older sender's frame does not, so the longest clip is assumed.
 */
export function noteRemoteSoundboardPlay(input: {
  channelId: string;
  userId: string;
  /** The admitted clip's length, from the cluster frame. Absent: the longest. */
  durationMs?: number;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const plays = livePlays(input.channelId, now);
  const duration = Math.min(
    SOUNDBOARD_MAX_DURATION_MS,
    Math.max(1, input.durationMs ?? SOUNDBOARD_MAX_DURATION_MS),
  );
  plays.push({ userId: input.userId, endsAt: now + duration });
  active.set(input.channelId, plays);
}

/** Drop finished plays in rooms that have gone quiet. */
export function sweepSoundboardPlays(now = Date.now()): void {
  for (const channelId of [...active.keys()]) {
    livePlays(channelId, now);
  }
}

if (typeof setInterval === "function") {
  setInterval(() => sweepSoundboardPlays(), 30_000).unref?.();
}

/**
 * Take a slot in this room.
 *
 * False when the room is full or this person is at their own cap. The same
 * person may still overlap a few of their own clips. The caller must not fan
 * out a false.
 */
export function offerSoundboardPlay(input: {
  channelId: string;
  userId: string;
  durationMs: number;
  now: number;
}): boolean {
  const plays = livePlays(input.channelId, input.now);
  if (soundboardRoomFull(input.channelId, input.now, input.userId)) {
    return false;
  }
  plays.push({
    userId: input.userId,
    endsAt: input.now + Math.max(1, input.durationMs),
  });
  active.set(input.channelId, plays);
  return true;
}

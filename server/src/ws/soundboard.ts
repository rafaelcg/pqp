import { SOUNDBOARD_ROOM_CONCURRENCY } from "@pqp/shared";

/**
 * Who may start a clip, and how many may be sounding.
 *
 * The seat check (are you in this room) stays in `voice.ts`, which already
 * holds the peer. This module is the rest: the bit, a moderator mute, and
 * the overlap cap. A refused play is silence. Nothing is stored.
 *
 * The cap is per process. Two API machines can each admit
 * `SOUNDBOARD_ROOM_CONCURRENCY` at once, the same way live reactions fold
 * a window on each machine. A play is a moment, and a shared counter would
 * be a database write on every click.
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

/** True when this room is already at the overlap cap. */
export function soundboardRoomFull(channelId: string, now = Date.now()): boolean {
  return livePlays(channelId, now).length >= SOUNDBOARD_ROOM_CONCURRENCY;
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
 * False only when the room is already full. The same person may overlap
 * their own clips. The caller must not fan out a false.
 */
export function offerSoundboardPlay(input: {
  channelId: string;
  userId: string;
  durationMs: number;
  now: number;
}): boolean {
  sweepSoundboardPlays(input.now);
  const plays = livePlays(input.channelId, input.now);
  if (plays.length >= SOUNDBOARD_ROOM_CONCURRENCY) {
    return false;
  }
  plays.push({
    userId: input.userId,
    endsAt: input.now + Math.max(1, input.durationMs),
  });
  active.set(input.channelId, plays);
  return true;
}

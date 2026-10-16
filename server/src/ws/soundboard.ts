import {
  SOUNDBOARD_MAX_DURATION_MS,
  SOUNDBOARD_PLAY_BURST,
  SOUNDBOARD_PLAY_REFILL_MS,
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
 * holds the peer. This module is the rest: the runtime flag, the bit, the
 * microphone, a moderator mute, and the overlap cap. A refused play is
 * silence. Nothing is stored.
 *
 * A clip is speech by other means, so whoever may not speak may not play
 * one. That is what closes a watch party's floor ("só hosts falam" denies
 * SPEAK to @everyone) and audience mode (`applyAudienceMode` takes `canSpeak`
 * away) without either of them knowing the soundboard exists.
 *
 * The caps are per process, but a play the other machine admitted is noted
 * here too (`noteRemoteSoundboardPlay`, from the cluster frame), so each
 * machine's count follows the whole room and the cap holds across `api-a` and
 * `api-b` up to a frame's travel time. A shared counter would be a database
 * write on every click.
 */

export interface SoundboardPlayGate {
  /** The `soundboard` runtime flag for the call's server, read now. */
  enabled: boolean;
  /**
   * Deafened: you would play a clip you cannot hear. Discord refuses the
   * same (`deaf` / `self_deaf` on its send rule). Self-mute is allowed,
   * there and here.
   */
  deafened: boolean;
  /** Resolved `USE_SOUNDBOARD`. False in a DM. */
  canUseSoundboard: boolean;
  /** The seat's `canSpeak`, after audience mode. Self-mute is not this. */
  canSpeak: boolean;
  /** Moderator mute. Self-mute does not belong here. */
  serverMuted: boolean;
  /** The frame's channel is the seat's channel. */
  channelMatches: boolean;
}

export function soundboardPlayAllowed(gate: SoundboardPlayGate): boolean {
  return (
    gate.enabled &&
    !gate.deafened &&
    gate.canUseSoundboard &&
    gate.canSpeak &&
    !gate.serverMuted &&
    gate.channelMatches
  );
}

interface ActivePlay {
  userId: string;
  endsAt: number;
}

const active = new Map<string, ActivePlay[]>();

export function resetSoundboardPlays(): void {
  active.clear();
  buckets.clear();
}

/**
 * A rate, on top of the overlap caps. The caps alone let one person replay
 * a short clip back to back for as long as they like (a 2 s laugh, about
 * 1.4 a second, forever). Five plays, then one every two seconds: mashing a
 * few in a row works, a sustained horn does not. The client keeps the same
 * budget so a refused click is told at once rather than after the echo wait.
 */
export { SOUNDBOARD_PLAY_BURST, SOUNDBOARD_PLAY_REFILL_MS };

const buckets = new Map<string, { tokens: number; at: number }>();

function takePlayToken(
  userId: string,
  now: number,
  options: { force?: boolean } = {},
): boolean {
  const bucket = buckets.get(userId) ?? { tokens: SOUNDBOARD_PLAY_BURST, at: now };
  const earned = Math.floor((now - bucket.at) / SOUNDBOARD_PLAY_REFILL_MS);
  if (earned > 0) {
    bucket.tokens = Math.min(SOUNDBOARD_PLAY_BURST, bucket.tokens + earned);
    bucket.at += earned * SOUNDBOARD_PLAY_REFILL_MS;
  }
  if (bucket.tokens >= SOUNDBOARD_PLAY_BURST) {
    // A full bucket banks no time: the next refill counts from now.
    bucket.at = now;
  }
  if (bucket.tokens <= 0 && !options.force) {
    buckets.set(userId, bucket);
    return false;
  }
  // A play the other machine admitted still spends this person's budget
  // here, so switching machines does not reset it. Never below zero.
  bucket.tokens = Math.max(0, bucket.tokens - 1);
  buckets.set(userId, bucket);
  return true;
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
  takePlayToken(input.userId, now, { force: true });
  const plays = livePlays(input.channelId, now);
  const duration = Math.min(
    SOUNDBOARD_MAX_DURATION_MS,
    Math.max(1, input.durationMs ?? SOUNDBOARD_MAX_DURATION_MS),
  );
  plays.push({ userId: input.userId, endsAt: now + duration });
  active.set(input.channelId, plays);
}

/** Drop finished plays in rooms that have gone quiet, and full budgets. */
export function sweepSoundboardPlays(now = Date.now()): void {
  for (const channelId of [...active.keys()]) {
    livePlays(channelId, now);
  }
  for (const [userId, bucket] of buckets) {
    if (now - bucket.at >= SOUNDBOARD_PLAY_BURST * SOUNDBOARD_PLAY_REFILL_MS) {
      buckets.delete(userId);
    }
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
  if (!takePlayToken(input.userId, input.now)) {
    return false;
  }
  plays.push({
    userId: input.userId,
    endsAt: input.now + Math.max(1, input.durationMs),
  });
  active.set(input.channelId, plays);
  return true;
}

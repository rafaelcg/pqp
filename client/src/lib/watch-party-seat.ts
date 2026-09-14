import { isWatchPartyChannelType } from "@pqp/shared";

/**
 * How long after taking an audience seat the "stream died" backstop stays
 * quiet. A seat is taken in one round trip; the `channel-live` that says
 * what the channel is playing is a separate frame from a separate path, and
 * on 2026-09-14 (14:57:58 UTC) a viewer pressed "Entrar no palco", was
 * seated, and left one second later because that frame had not arrived yet.
 */
export const AUDIENCE_SEAT_GRACE_MS = 10_000;

/**
 * Whether a seat in a watch party should be released.
 *
 * Watching is select plus HLS. A seat is the host's LiveKit pipe (or a
 * mic the party bar handed out), not "I opened the channel". Encerrar
 * always `voice.leave()`s on the host path; this is the backstop for
 * audience seats when the stream dies, and for anybody still seated
 * when the party is over (so leave-voice chrome does not linger).
 *
 * "THE STREAM DIED" IS NOT "WE WERE NEVER TOLD". `hasLiveStream: false`
 * used to be the whole test, and an absent `channelLive` entry reads as
 * false: a client whose socket had not yet received a `channel-live` for
 * the channel (on 2026-09-14, every viewer on the API machine that was not
 * running the egress) took an audience seat and released it a second
 * later, so "Entrar no palco" did nothing. So the release needs
 * `streamEnded`: a `stream: null` the server vouched for (`channel-live`
 * with `ended: true`, or the one-time `GET /api/channels/:id/live` answering
 * null). And it needs the seat to be older than `AUDIENCE_SEAT_GRACE_MS`, so
 * a frame that is merely late is not read as a stop. A party that has ended
 * is released regardless: that is a state, not an absence.
 */
export function shouldReleaseAudienceWatchSeat(input: {
  channelType: string | null | undefined;
  isAudienceSeat: boolean;
  isSharingScreen: boolean;
  voiceStatus: string;
  partyState: "draft" | "live" | "ended" | "cancelled" | null | undefined;
  hasLiveStream: boolean;
  /**
   * The channel's `channelLive` entry holds a `stream: null` the server
   * vouched for (`channel-live { ended: true }`, or the one-time `GET /live`
   * answering null). False when the entry is absent or its null came without
   * the marker: that is "not told yet", not "over".
   */
  streamEnded: boolean;
  /** How long ago this seat was taken; null when unknown (treated as old). */
  seatAgeMs: number | null;
}): boolean {
  if (!input.channelType || !isWatchPartyChannelType(input.channelType)) {
    return false;
  }
  if (input.voiceStatus === "idle") {
    return false;
  }
  if (input.partyState === "ended" || input.partyState === "cancelled") {
    return true;
  }
  if (!input.isAudienceSeat) {
    return false;
  }
  if (input.hasLiveStream) {
    return false;
  }
  if (input.isSharingScreen) {
    return false;
  }
  if (!input.streamEnded) {
    return false;
  }
  if (input.seatAgeMs !== null && input.seatAgeMs < AUDIENCE_SEAT_GRACE_MS) {
    return false;
  }
  return true;
}

/**
 * WHEN THE CURRENT SEAT WAS TAKEN, for the grace above.
 *
 * Kept here, and pure, because the rule is easy to get subtly wrong in an
 * effect and impossible to test there. It was wrong: the clock was keyed on
 * the ROOM alone, so somebody already in the voice room who then pressed
 * "Entrar no palco" kept the timestamp from when they joined the room. A tab
 * that had been sitting in the channel for a minute therefore took an
 * audience seat with its grace already spent, which is the one case the
 * grace exists for. Taking (or giving up) a seat is itself the event: the
 * clock restarts whenever `isAudienceSeat` changes, not only when the room
 * does.
 */
export interface AudienceSeatClock {
  channelId: string;
  isAudienceSeat: boolean;
  /** `Date.now()` when this seat began. */
  at: number;
}

export function nextAudienceSeatClock(
  previous: AudienceSeatClock | null,
  input: {
    channelId: string | null | undefined;
    isAudienceSeat: boolean;
    voiceStatus: string;
    now: number;
  },
): AudienceSeatClock | null {
  if (!input.channelId || input.voiceStatus === "idle") {
    return null;
  }
  if (
    previous &&
    previous.channelId === input.channelId &&
    previous.isAudienceSeat === input.isAudienceSeat
  ) {
    // The same seat in the same room: a re-render, a roster frame, a
    // reconnect. Not a new seat, so not a new grace.
    return previous;
  }
  return {
    channelId: input.channelId,
    isAudienceSeat: input.isAudienceSeat,
    at: input.now,
  };
}

/** How long this channel's seat has been held; null when it is not this one. */
export function audienceSeatAgeMs(
  clock: AudienceSeatClock | null,
  channelId: string,
  now: number,
): number | null {
  return clock && clock.channelId === channelId ? now - clock.at : null;
}

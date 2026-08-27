import type { WatchPartyState } from "@pqp/shared";
import { logEvent } from "../lib/log.js";
import { createRateLimiter } from "../lib/rate-limit.js";

/**
 * THE ROOM'S WATCH-PARTY STATE, HELD HERE RATHER THAN RELAYED THROUGH.
 *
 * The contract (`packages/shared/src/watch-party.ts`) is the thing to read
 * first; this file is the server half of it. Two of its rules are the reason
 * this module exists at all instead of one more `broadcastToRoom` call inside
 * `voice.ts`:
 *
 * 1. A peer joining mid video has to land at the right position, and it has no
 *    way to ask anybody for it. Something has to remember.
 * 2. The last participant leaving has to tear the party down, which means
 *    knowing there was one.
 *
 * Neither is possible for a dumb relay, and once the current state is held the
 * third rule becomes cheap: an incoming write can be COMPARED to it, which is
 * what lets the rate limiter coalesce instead of drop. See `applyWatchPartyWrite`.
 *
 * SCOPE. Per process, exactly like `peers` in `voice.ts`, and for the same
 * reason: a watch party lives inside a voice room, voice is deliberately not on
 * the cluster bus, and a room therefore lives on one instance. This map does not
 * widen that ceiling and must not be written as though it had. See the banner
 * above `peers` for the full argument.
 *
 * NO MEDIA. Nothing here carries video or audio, and nothing here ever should.
 * Every participant streams from YouTube themselves; what travels is the small
 * object below.
 */
const parties = new Map<string, WatchPartyState>();

/**
 * THE LIMITER EXISTS FOR ONE TRAFFIC SHAPE: a seek scrub, which emits
 * continuously while a thumb is down and would otherwise spend the whole room's
 * bandwidth on positions nobody will ever see.
 *
 * It is NOT the `set-voice-state` limiter and it must not behave like one. That
 * one drops the frame past its budget, which is safe because a stale mute badge
 * harms nobody. A dropped PAUSE is a different thing entirely: its author sits
 * at a `rev` nobody else can reach, and since their `rev` is the higher one they
 * ignore every frame the room sends afterwards. The room splits, permanently,
 * with no path back. So the budget is spent by every write and REFUSES none of
 * them; what it decides is only whether a position-only update is worth a
 * fan-out right now. `applyWatchPartyWrite` is where that distinction is made.
 *
 * Keyed on the user id, like the other per-user limits in `voice.ts`.
 */
const writeLimiter = createRateLimiter({ capacity: 15, refillPerSecond: 5 });

/** Test hook: refill every watch-party write budget. */
export function resetWatchPartyLimits(): void {
  writeLimiter.reset();
}

/** Test hook: forget every held party. */
export function resetWatchParties(): void {
  parties.clear();
}

/** What a room is currently watching, or null when there is no party. */
export function getWatchPartyState(
  voiceChannelId: string,
): WatchPartyState | null {
  return parties.get(voiceChannelId) ?? null;
}

/**
 * Forget a room's party. Returns whether there was one, so the caller can send
 * the teardown frame only when it means something.
 */
export function endWatchParty(voiceChannelId: string): boolean {
  const held = parties.get(voiceChannelId);
  if (!held) {
    return false;
  }
  parties.delete(voiceChannelId);
  logEvent("voice.watchPartyEnd", { voiceChannelId, videoId: held.videoId });
  return true;
}

/**
 * A write that changes what the room is watching, or whether it is watching it.
 *
 * This is the line the limiter is not allowed to cross. Everything else about a
 * state is a position, and a position is worth coalescing precisely because a
 * later one supersedes it; `videoId` and `status` supersede nothing, and a lost
 * one is the room split described above `writeLimiter`.
 *
 * A first write (nothing held) and a teardown (`null`) are structural too: one
 * opens the party and the other closes it, and neither has a successor coming
 * that would repair a drop.
 */
export function isStructuralWrite(
  held: WatchPartyState | null,
  incoming: WatchPartyState | null,
): boolean {
  if (held === null || incoming === null) {
    return true;
  }
  return incoming.videoId !== held.videoId || incoming.status !== held.status;
}

/**
 * Whether `incoming` lost to what the room already holds, under the contract's
 * own ordering: higher `rev` wins, ties break on `actorId` lexically.
 *
 * Applied here so the HELD state is always the room's winner. Without it a
 * straggling frame at an old `rev` would overwrite the map: every live peer
 * would correctly ignore the rebroadcast, so nothing visible would break, and
 * then the next person to join would be handed the loser and sit out of step
 * with a room that has stopped talking and will not correct them.
 *
 * A TIE FROM THE SAME ACTOR IS NOT STALE, deliberately. An unechoed write is
 * retried, and a resend carries the `rev` it always carried; treating it as
 * stale would refuse the echo the resend is waiting for and the client would
 * retry forever.
 */
export function isStaleWrite(
  held: WatchPartyState | null,
  incoming: WatchPartyState | null,
): boolean {
  if (held === null || incoming === null) {
    return false;
  }
  if (incoming.rev !== held.rev) {
    return incoming.rev < held.rev;
  }
  return incoming.actorId < held.actorId;
}

export type WatchPartyWrite =
  /** Adopted. Fan this out to the room, sender included. */
  | { kind: "accepted"; state: WatchPartyState | null }
  /**
   * Adopted but not worth a fan-out yet: a position-only update while the
   * budget is empty. The client learns this by never seeing its echo and
   * retries, which is the contract's own recovery mechanism rather than a
   * second one invented here.
   */
  | { kind: "coalesced" }
  /**
   * Lost to the held state. `held` goes back to the sender alone, which is not
   * a courtesy: a client that hears nothing retries the write it already lost,
   * and handing it the winner is what ends that loop in one round trip.
   */
  | { kind: "stale"; held: WatchPartyState };

/**
 * Take one `set-watch-party` from a room participant.
 *
 * Ordering matters: staleness first (a loser is never adopted, whatever it
 * would have changed), then structure against the state we hold, then the
 * budget. The budget is spent by structural writes as well as coalescible ones,
 * so a burst of them starves the scrub traffic rather than the other way round,
 * but its answer is only ever consulted for a position-only update.
 */
export function applyWatchPartyWrite(
  voiceChannelId: string,
  incoming: WatchPartyState | null,
  actorUserId: string,
): WatchPartyWrite {
  const held = getWatchPartyState(voiceChannelId);

  if (isStaleWrite(held, incoming)) {
    // `isStaleWrite` only returns true with a held state, so this is not null.
    return { kind: "stale", held: held as WatchPartyState };
  }

  const structural = isStructuralWrite(held, incoming);
  const withinBudget = writeLimiter.take(actorUserId);

  if (!structural && !withinBudget) {
    // Held, not broadcast. The room's newest position is still the one this
    // map answers a mid-video join with, so coalescing costs bandwidth and
    // nothing else.
    if (incoming) {
      parties.set(voiceChannelId, incoming);
    }
    return { kind: "coalesced" };
  }

  if (incoming === null) {
    endWatchParty(voiceChannelId);
    return { kind: "accepted", state: null };
  }

  if (held === null) {
    logEvent("voice.watchPartyStart", {
      voiceChannelId,
      userId: actorUserId,
      videoId: incoming.videoId,
    });
  }
  parties.set(voiceChannelId, incoming);
  return { kind: "accepted", state: incoming };
}

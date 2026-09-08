import {
  LIVE_REACTION_RATE_PER_SECOND,
  LIVE_REACTION_WINDOW_MS,
  type LiveReactionCount,
  type LiveReactionEmoji,
} from "@pqp/shared";
import { createRateLimiter } from "../lib/rate-limit.js";

/**
 * THE COALESCER. Read `packages/shared/src/live-reactions.ts` first for what
 * the feature is; this file is the only thing between a tap and a fan-out.
 *
 * Every tap that survives the limiter lands in a per-channel bucket, and the
 * bucket is emptied once per window. That inversion is the whole reason this
 * module exists rather than a `broadcastToRoom` call at the frame handler:
 * relaying each tap makes the room's outbound traffic the PRODUCT of taps and
 * participants, which is exactly the shape that fell over when 212 people
 * arrived from a Twitch stream in twenty minutes. Coalescing makes it the
 * product of ROOMS and participants, and a hundred people tapping is then the
 * same cost as one.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 * - No persistence. A window that is not delivered is gone. For confetti that
 *   is correct, and it is why nothing in here can fail in a way worth logging.
 * - No identity. The bucket counts emoji, not people, so a fan-out cannot leak
 *   who tapped even by accident.
 * - No audience check. That belongs to the caller, which already holds the
 *   room membership the join granted. See the `live-reaction` branch in
 *   `voice.ts`.
 *
 * SCOPE is per process, like `peers` and `parties`. With `CLUSTER_BUS` on,
 * each instance coalesces its own taps and publishes its own window; the other
 * instance delivers that window to its half of the room without re-coalescing.
 * So a two-machine room sees two windows per 250ms rather than one, which
 * costs a frame and changes nothing a viewer can see.
 */

/**
 * Taps per socket. `capacity` is the burst a real thumb can produce (a quick
 * double tap while the last one is still refilling) and `refillPerSecond` is
 * the sustained ceiling from the contract.
 *
 * Keyed by the caller, which passes a SOCKET key rather than a user id: the
 * limit is on a connection, so opening a second tab is a second budget. That
 * is intentional and matches what a person can physically do; the flood
 * backstop for a machine opening sockets is `socketLimiter` in `index.ts`.
 */
const tapLimiter = createRateLimiter({
  capacity: LIVE_REACTION_RATE_PER_SECOND,
  refillPerSecond: LIVE_REACTION_RATE_PER_SECOND,
});

interface Window {
  counts: Map<LiveReactionEmoji, number>;
  timer: ReturnType<typeof setTimeout>;
}

const windows = new Map<string, Window>();

/** Next `seq` per channel. Survives an empty window, resets with the module. */
const sequences = new Map<string, number>();

export type LiveReactionSink = (
  channelId: string,
  items: LiveReactionCount[],
  seq: number,
) => void;

let sink: LiveReactionSink | null = null;

/**
 * Where a flushed window goes. Set once at wiring time by `voice.ts` rather
 * than imported from it, because `voice.ts` already imports this module and
 * the other direction would be a cycle.
 */
export function setLiveReactionSink(next: LiveReactionSink | null): void {
  sink = next;
}

/** Test hook: refill every tap budget. */
export function resetLiveReactionLimits(): void {
  tapLimiter.reset();
}

/** Test hook: drop every pending window and rewind every sequence. */
export function resetLiveReactions(): void {
  for (const window of windows.values()) {
    clearTimeout(window.timer);
  }
  windows.clear();
  sequences.clear();
}

/**
 * Empty one channel's bucket into the sink.
 *
 * Exported so a test can drive a window without waiting on wall clock, and so
 * the timer callback and that test take the identical path. An empty or
 * missing bucket sends nothing: `items` is `.min(1)` in the schema, and a
 * frame carrying no reactions would make the client spawn nothing while still
 * burning a `seq`.
 */
export function flushLiveReactions(channelId: string): void {
  const window = windows.get(channelId);
  if (!window) {
    return;
  }
  clearTimeout(window.timer);
  windows.delete(channelId);
  const items: LiveReactionCount[] = [];
  for (const [emoji, count] of window.counts) {
    if (count > 0) {
      items.push({ emoji, count });
    }
  }
  if (items.length === 0) {
    return;
  }
  const seq = sequences.get(channelId) ?? 0;
  sequences.set(channelId, seq + 1);
  sink?.(channelId, items, seq);
}

/**
 * Take one tap.
 *
 * Returns whether it was counted. `false` is a silent drop and the caller must
 * treat it as one: no error frame, no log line, no counter the sender can see.
 * The only client that can reach this is one tapping faster than a person, and
 * answering it is what turns a drop into a retry loop.
 *
 * The tap is counted BEFORE the window is scheduled, so the first tap of a
 * quiet room is already in the bucket the timer will find.
 */
export function offerLiveReaction(
  channelId: string,
  emoji: LiveReactionEmoji,
  socketKey: string,
): boolean {
  if (!tapLimiter.take(socketKey)) {
    return false;
  }
  const existing = windows.get(channelId);
  if (existing) {
    existing.counts.set(emoji, (existing.counts.get(emoji) ?? 0) + 1);
    return true;
  }
  const timer = setTimeout(
    () => flushLiveReactions(channelId),
    LIVE_REACTION_WINDOW_MS,
  );
  // A pending window must never hold the process open: this is confetti, and
  // an instance shutting down with 200ms of it queued should shut down.
  timer.unref?.();
  windows.set(channelId, { counts: new Map([[emoji, 1]]), timer });
  return true;
}

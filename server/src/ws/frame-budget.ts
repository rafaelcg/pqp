import { MESH_VOICE_LIMIT } from "@pqp/shared";
import { createRateLimiter } from "../lib/rate-limit.js";

/**
 * Per-connection frame budget: how many WebSocket frames one socket may send
 * before the server closes it with 4429.
 *
 * TWO BUCKETS, AND WHY. There used to be one, 60 frames of burst refilled at
 * 20/s, and it was sized for a person: chat, typing, presence, a mute toggle.
 * Mesh voice signaling is not a person, it is a browser. A peer connection
 * trickles every ICE candidate it gathers as its own `ice-candidate` frame,
 * one per local address per STUN/TURN URL, plus an end-of-candidates frame,
 * plus the offer or answer, and it does that for EVERY other seat at once
 * when it joins, and again for every seat on an ICE restart. Measured locally
 * (Chromium, one interface, STUN only) the eighth joiner of a mesh room sent
 * 32 frames inside one second, about four candidates per peer. Production
 * hands out TURN with several URLs, and Chromium allocates a relay per local
 * address per URL, so a laptop on Wi-Fi with IPv6 lands at 15 to 30
 * candidates per peer and a full room's join is well past 60 in the first
 * second. Production closed 11 sockets for flooding in the week to
 * 2026-09-23; every one whose close was logged was in voice, and several went
 * within a second of a reconnect: the guard was hanging up calls, not floods.
 *
 * So WebRTC relay frames (`offer`, `answer`, `ice-candidate`) draw from their
 * own bucket, sized for a full mesh room, and never spend the general one.
 * Everything else, including frames that do not parse and frames with no
 * type, keeps exactly the budget it always had. Moving a frame into the relay
 * bucket by lying about its type buys nothing: the frame is then routed to
 * the relay handler and nowhere else, which drops it unless it names a peer
 * in the sender's own room.
 */

/** The frame types that draw from the relay bucket. */
export const RELAY_FRAME_TYPES: ReadonlySet<string> = new Set([
  "offer",
  "answer",
  "ice-candidate",
]);

/**
 * Frames one peer connection may need for a single negotiation: the SDP, up
 * to ~30 trickled candidates on a multi-homed machine with TURN, the
 * end-of-candidates marker, and room for a renegotiation in the same breath.
 */
export const RELAY_FRAMES_PER_PEER = 40;

/**
 * Unchanged from the single bucket this replaces. Chat, typing, presence,
 * voice state, raised hands, music, reactions: everything a human drives.
 */
export const GENERAL_BUDGET = { capacity: 60, refillPerSecond: 20 } as const;

/**
 * A full mesh room's join (or ICE restart) in one burst: every other seat
 * times a negotiation's worth of frames, 280 at the mesh ceiling of 8. The
 * refill is slow on purpose. A settled call sends no signaling at all, so the
 * refill only has to cover a second restart ten seconds after the first, and
 * a socket pushing relay frames at a sustained 28/s is spamming its roommates.
 */
export const RELAY_BUDGET = {
  capacity: (MESH_VOICE_LIMIT - 1) * RELAY_FRAMES_PER_PEER,
  refillPerSecond: Math.ceil(((MESH_VOICE_LIMIT - 1) * RELAY_FRAMES_PER_PEER) / 10),
} as const;

export type FrameBucket = "general" | "relay";

/** How many recent frame types a flood log line summarises. */
const RECENT_TYPES = 64;

export interface FrameBudget {
  /**
   * Spend one frame of type `type` (undefined for a frame that did not parse
   * or carried no string type). Returns the bucket that ran dry, or null when
   * the frame is admitted.
   */
  take(type: string | undefined): FrameBucket | null;
  /**
   * The most frequent types among the last frames this socket sent, as
   * `type:count` pairs, for the `ws.flood` line. A flood that does not say
   * what it was flooding with costs the next person an afternoon.
   */
  recentSummary(): string;
}

export function createFrameBudget(
  knownTypes: ReadonlySet<string>,
  now: () => number = Date.now,
): FrameBudget {
  const general = createRateLimiter({ ...GENERAL_BUDGET, now });
  const relay = createRateLimiter({ ...RELAY_BUDGET, now });
  const recent: string[] = [];

  return {
    take(type) {
      // The type is client supplied: only a name this server routes is worth
      // recording, and anything else is one label, so a hostile socket cannot
      // make its own log line arbitrarily long.
      recent.push(type === undefined ? "unparsed" : knownTypes.has(type) ? type : "other");
      if (recent.length > RECENT_TYPES) {
        recent.shift();
      }
      if (type !== undefined && RELAY_FRAME_TYPES.has(type)) {
        return relay.take("self") ? null : "relay";
      }
      return general.take("self") ? null : "general";
    },

    recentSummary() {
      const counts = new Map<string, number>();
      for (const type of recent) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => `${type}:${count}`)
        .join(",");
    },
  };
}

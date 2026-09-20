/**
 * `calls.*` on `GET /api/admin/metrics`: server-truth counts of what happens
 * when somebody tries to be in a call, and what the ring layer on top of a DM
 * or group call does.
 *
 * WHY THIS EXISTS. Until this, pqp had no number anywhere for how many calls
 * were attempted, how many connected, and how many were refused and why. The
 * MoonKase spike (2026-09-05, `docs/`) was 212 signups whose calls the mesh
 * cap of 8 refused, and the only evidence was after the fact: nobody could
 * watch the refusal happening. The server initiates and routes every call, so
 * it is the one place the outcome is known for certain — a `join-voice-room`
 * either seats a peer or takes one of a small, named set of refusal doors, and
 * a DM/group ring is either answered, declined, or dies on the timeout.
 *
 * WHAT IT IS. Cumulative in-process counters since boot (or the last
 * `resetCallMetrics()`, which only tests call), the same convention
 * `voice.roster`, `db.tx.byPath` and the other counters on that endpoint use:
 * a number that only grows is honest about what it is, and a rate is for the
 * caller (Prometheus) to derive by polling twice. Per instance: on a
 * multi-machine cluster these belong to whichever machine answered the
 * request, exactly like `voice.roster.deltas`.
 *
 * CARDINALITY. Every label here is a fixed, small enum — transports (2),
 * scopes (3), refusal reasons (8), ring kinds (2), ring-end reasons (2) — and
 * never a user id, channel id or anything unbounded. The snapshot pre-seeds
 * every key to zero so a Prometheus series exists before its first event
 * rather than appearing mid-incident.
 */

/** The media path a room connected on. DMs are always mesh by policy. */
export type CallTransport = "mesh" | "livekit";

/** What kind of room the join was for. A conversation is `dm` or `group`. */
export type CallScope = "dm" | "group" | "server";

/**
 * Why a `join-voice-room` was refused. Each is a distinct, server-known door
 * in `handleVoiceMessage`'s join branch; anything not on this list connects.
 */
export type JoinRefusedReason =
  | "no-access"
  | "blocked"
  | "timeout"
  | "character"
  | "invalid-channel"
  | "transport-unsupported"
  | "room-full"
  | "watch-party-full";

/** A ring is a DM or group call; a server channel is joined, never rung. */
export type RingKind = "dm" | "group";

/** How an UNANSWERED ring ended. An answered ring is counted separately. */
export type RingEndReason = "timeout" | "cancelled";

const TRANSPORTS: readonly CallTransport[] = ["mesh", "livekit"];
const SCOPES: readonly CallScope[] = ["dm", "group", "server"];
const REFUSED_REASONS: readonly JoinRefusedReason[] = [
  "no-access",
  "blocked",
  "timeout",
  "character",
  "invalid-channel",
  "transport-unsupported",
  "room-full",
  "watch-party-full",
];
const RING_KINDS: readonly RingKind[] = ["dm", "group"];
const RING_END_REASONS: readonly RingEndReason[] = ["timeout", "cancelled"];

let joinAttempts = 0;
let joinConnected = 0;
const connectedByTransport = new Map<CallTransport, number>();
const connectedByScope = new Map<CallScope, number>();
const refusedByReason = new Map<JoinRefusedReason, number>();

let rings = 0;
const ringsByKind = new Map<RingKind, number>();
let ringsAnswered = 0;
const ringsAnsweredByKind = new Map<RingKind, number>();
let ringsDeclined = 0;
const ringsEndedByReason = new Map<RingEndReason, number>();

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** A `join-voice-room` frame that passed the room limiter and is being tried. */
export function noteJoinAttempt(): void {
  joinAttempts += 1;
}

/** A join that seated a peer: the call connected. */
export function noteJoinConnected(transport: CallTransport, scope: CallScope): void {
  joinConnected += 1;
  bump(connectedByTransport, transport);
  bump(connectedByScope, scope);
}

/** A join refused at one of the named doors. */
export function noteJoinRefused(reason: JoinRefusedReason): void {
  bump(refusedByReason, reason);
}

/** A DM/group ring was committed and fanned out. */
export function noteRingStarted(kind: RingKind): void {
  rings += 1;
  bump(ringsByKind, kind);
}

/** The first person answered a ring (joined the room while it was ringing). */
export function noteRingAnswered(kind: RingKind): void {
  ringsAnswered += 1;
  bump(ringsAnsweredByKind, kind);
}

/** Somebody actively declined a ring. */
export function noteRingDeclined(): void {
  ringsDeclined += 1;
}

/** An UNANSWERED ring ended (rang out, or the room emptied before an answer). */
export function noteRingEnded(reason: RingEndReason): void {
  bump(ringsEndedByReason, reason);
}

function seed<K extends string>(keys: readonly K[], map: Map<K, number>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    out[key] = map.get(key) ?? 0;
  }
  return out;
}

export interface CallMetrics {
  /** `join-voice-room` frames tried (after the per-user room rate limiter). */
  joinAttempts: number;
  /** Of those, how many seated a peer. `joinAttempts - joinConnected` is the
   *  refusal total, of which the named reasons below are the explained part. */
  joinConnected: number;
  /** Connected joins by media path. DMs are always mesh. */
  joinConnectedByTransport: Record<CallTransport, number>;
  /** Connected joins by room kind. */
  joinConnectedByScope: Record<CallScope, number>;
  /** Refusals by the door they took. Bounded set, always all keys present. */
  joinRefusedByReason: Record<JoinRefusedReason, number>;
  /** DM/group rings committed. */
  rings: number;
  ringsByKind: Record<RingKind, number>;
  /** Rings where at least one person answered. */
  ringsAnswered: number;
  ringsAnsweredByKind: Record<RingKind, number>;
  /** Rings someone actively declined (a decline is not on its own an end). */
  ringsDeclined: number;
  /** Unanswered rings that ended: `timeout` rang out, `cancelled` emptied. */
  ringsEndedByReason: Record<RingEndReason, number>;
}

/** Snapshot for `GET /api/admin/metrics`. */
export function callMetricsSnapshot(): CallMetrics {
  return {
    joinAttempts,
    joinConnected,
    joinConnectedByTransport: seed(TRANSPORTS, connectedByTransport),
    joinConnectedByScope: seed(SCOPES, connectedByScope),
    joinRefusedByReason: seed(REFUSED_REASONS, refusedByReason),
    rings,
    ringsByKind: seed(RING_KINDS, ringsByKind),
    ringsAnswered,
    ringsAnsweredByKind: seed(RING_KINDS, ringsAnsweredByKind),
    ringsDeclined,
    ringsEndedByReason: seed(RING_END_REASONS, ringsEndedByReason),
  };
}

/** Test seam: forget every count. */
export function resetCallMetrics(): void {
  joinAttempts = 0;
  joinConnected = 0;
  connectedByTransport.clear();
  connectedByScope.clear();
  refusedByReason.clear();
  rings = 0;
  ringsByKind.clear();
  ringsAnswered = 0;
  ringsAnsweredByKind.clear();
  ringsDeclined = 0;
  ringsEndedByReason.clear();
}

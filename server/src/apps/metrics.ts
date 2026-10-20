import type { AppEndReason } from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * The apps counters, in process and cumulative since boot like the other
 * `GET /api/admin/metrics` blocks (the exporter sums the replicas). Written
 * where the thing happens, read by the metrics block. Nothing here stores
 * anything about a person or a session.
 */

const counters = {
  starts: 0,
  startsRefused: new Map<string, number>(),
  ends: new Map<AppEndReason, number>(),
  joins: 0,
  joinsRefused: new Map<string, number>(),
  /** Frames the server dropped or refused because of a cap, by what capped them. */
  framesDropped: new Map<string, number>(),
  stateWrites: 0,
  stateWritesCoalesced: 0,
  events: 0,
  handoffs: new Map<string, number>(),
  hostGoneStamped: 0,
  participantsRemoved: 0,
  deadInstanceSeats: new Map<string, number>(),
  sweepRuns: 0,
  sweepFailures: 0,
};

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function recordAppStart(): void {
  counters.starts += 1;
}

/** A start that was refused, by the machine token of the refusal. */
export function recordAppStartRefused(reason: string): void {
  bump(counters.startsRefused, reason);
}

export function recordAppEnd(reason: AppEndReason): void {
  bump(counters.ends, reason);
}

export function recordAppJoin(): void {
  counters.joins += 1;
}

/** A join refused, by the `app-error` code (`full`, `not-allowed`, `ended`, `rate-limited`). */
export function recordAppJoinRefused(code: string): void {
  bump(counters.joinsRefused, code);
}

/** A frame refused or dropped by a cap: `event-rate`, `event-size`, `state-size`, `state-rate`, `join-rate`. */
export function recordAppFrameDropped(reason: string): void {
  bump(counters.framesDropped, reason);
}

export function recordAppStateWrite(): void {
  counters.stateWrites += 1;
}

/** Patches that shared a write with an earlier one (the last value won). */
export function recordAppStateCoalesced(patches: number): void {
  counters.stateWritesCoalesced += patches;
}

export function recordAppEvent(): void {
  counters.events += 1;
}

/** The host role moved: `sweep` after the countdown, `take` by the chosen person ("Assumir agora"). */
export function recordAppHandoff(via: "sweep" | "take"): void {
  bump(counters.handoffs, via);
}

/** A host with no present seat started the countdown. */
export function recordAppHostGone(): void {
  counters.hostGoneStamped += 1;
}

/** A seat released because its person lost VIEW_CHANNEL (or CONNECT in a voice channel). */
export function recordAppParticipantsRemoved(n: number): void {
  counters.participantsRemoved += n;
}

/** Seats of a dead instance: `orphaned` (now held) and `released` (hold over). */
export function recordAppDeadInstanceSeats(kind: "orphaned" | "released", n: number): void {
  counters.deadInstanceSeats.set(kind, (counters.deadInstanceSeats.get(kind) ?? 0) + n);
}

export function recordAppSweep(ok: boolean): void {
  if (ok) {
    counters.sweepRuns += 1;
  } else {
    counters.sweepFailures += 1;
  }
}

export function appCountersSnapshot(): {
  starts: number;
  startsRefused: Record<string, number>;
  ends: Record<string, number>;
  joins: number;
  joinsRefused: Record<string, number>;
  framesDropped: Record<string, number>;
  stateWrites: number;
  stateWritesCoalesced: number;
  events: number;
  handoffs: Record<string, number>;
  hostGoneStamped: number;
  participantsRemoved: number;
  deadInstanceSeats: Record<string, number>;
  sweepRuns: number;
  sweepFailures: number;
} {
  return {
    starts: counters.starts,
    startsRefused: Object.fromEntries(counters.startsRefused),
    ends: Object.fromEntries(counters.ends),
    joins: counters.joins,
    joinsRefused: Object.fromEntries(counters.joinsRefused),
    framesDropped: Object.fromEntries(counters.framesDropped),
    stateWrites: counters.stateWrites,
    stateWritesCoalesced: counters.stateWritesCoalesced,
    events: counters.events,
    handoffs: Object.fromEntries(counters.handoffs),
    hostGoneStamped: counters.hostGoneStamped,
    participantsRemoved: counters.participantsRemoved,
    deadInstanceSeats: Object.fromEntries(counters.deadInstanceSeats),
    sweepRuns: counters.sweepRuns,
    sweepFailures: counters.sweepFailures,
  };
}

export function resetAppCountersForTests(): void {
  counters.starts = 0;
  counters.startsRefused.clear();
  counters.ends.clear();
  counters.joins = 0;
  counters.joinsRefused.clear();
  counters.framesDropped.clear();
  counters.stateWrites = 0;
  counters.stateWritesCoalesced = 0;
  counters.events = 0;
  counters.handoffs.clear();
  counters.hostGoneStamped = 0;
  counters.participantsRemoved = 0;
  counters.deadInstanceSeats.clear();
  counters.sweepRuns = 0;
  counters.sweepFailures = 0;
}

export interface AppsMetrics {
  /**
   * Sessions live right now, from the table (so every instance and the worker
   * agree), and how many people are seated in them. `null` when the database
   * could not be asked: never a made-up zero.
   */
  live: { sessions: number; seats: number; byApp: Record<string, number> } | null;
  /**
   * Since this process started, like the push and nudge counters: with two
   * instances and a worker read each and sum. `starts` / `startsRefused` /
   * `ends` by reason / `handoffs` by how (`sweep`, `take`) / `joins` and
   * `joinsRefused` by `app-error` code / `framesDropped` by the cap that
   * refused them (`event-rate`, `event-size`, `event-not-allowed`,
   * `event-unseated`, `state-too-large`, `state-rate`, ...) / `stateWrites`
   * and `stateWritesCoalesced` (patches that shared a write) / `events`
   * relayed / the sweeps (`hostGoneStamped`, `participantsRemoved`,
   * `deadInstanceSeats`, `sweepRuns`, `sweepFailures`).
   */
  counters: ReturnType<typeof appCountersSnapshot>;
}

/** The `apps` block of `GET /api/admin/metrics`. Live, never from the 30 s cache. */
export async function appsMetrics(): Promise<AppsMetrics> {
  let live: AppsMetrics["live"] = null;
  try {
    const [sessions, seats] = await Promise.all([
      getPool().query<{ app_id: string; n: number }>(
        `SELECT app_id, count(*)::int AS n FROM app_sessions WHERE status = 'live' GROUP BY app_id`,
      ),
      getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM app_session_participants p
           JOIN app_sessions s ON s.id = p.session_id AND s.status = 'live'
          WHERE p.left_at IS NULL`,
      ),
    ]);
    live = {
      sessions: sessions.rows.reduce((total, row) => total + row.n, 0),
      seats: seats.rows[0]?.n ?? 0,
      byApp: Object.fromEntries(sessions.rows.map((row) => [row.app_id, row.n])),
    };
  } catch {
    live = null;
  }
  return { live, counters: appCountersSnapshot() };
}

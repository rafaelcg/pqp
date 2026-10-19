import { randomBytes } from "node:crypto";
import type { AppManifest, AppRole } from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * WHO IS IN A SESSION: the participant rows and the rules that change them.
 *
 * A person is one row per session (`PRIMARY KEY (session_id, user_id)`), however
 * many tabs they have open. `seat_id` is random per session and is the only
 * identifier the app ever sees. Two timestamps say how a seat ended or is
 * ending, the same split as `voice_raised_hands`:
 *
 *  - `left_at`: the person left on purpose (`app-leave`), or the session ended.
 *    Not held.
 *  - `orphaned_at`: the socket went away. The seat is HELD for 90 s so a reload
 *    or a dead wifi comes back to the same seat, then released by the sweep.
 *
 * `instance_id` is the API process that owns the person's socket, so a
 * per-instance sweep can reclaim ITS OWN rows (pitfall 13: every sweep needs a
 * case for its own rows), and only the global sweep touches the rows of a dead
 * instance (`apps/sweeps.ts`, behind `otherLeasesTrustworthy`, pitfall 18).
 *
 * Joining takes the session row's lock, so two joins at once on two machines
 * count the same seats and the last place goes to one of them, never both.
 */

/** How long a seat is held after its socket goes away. The voice resume window. */
export const APP_ORPHAN_HOLD_MS = 90_000;

/** A random seat id: 22 characters of base64url, never derived from a user id. */
export function newSeatId(): string {
  return randomBytes(16).toString("base64url");
}

export type JoinRefusal = "full" | "not-allowed" | "ended";

export type JoinOutcome =
  | { ok: true; seatId: string; role: AppRole; resumed: boolean }
  | { ok: false; code: JoinRefusal };

export interface JoinOptions {
  sessionId: string;
  userId: string;
  instanceId: string;
  manifest: Pick<AppManifest, "players">;
  /** The client asked to watch. */
  asSpectator: boolean;
  /**
   * Whether this server may have spectators of this app at all (D14: an
   * emulator app only when `locadora_share` is on). The manifest's own
   * `players.spectators` is checked on top of it.
   */
  spectatorsAllowed: boolean;
}

/**
 * Seat `userId` in the session. A person already seated (`left_at` null, held
 * or not) resumes the same row and seat id with the role they had. A person who
 * left, or who was never there, is placed again: a player while there is room,
 * else a spectator if the app and the server allow it, else `full`.
 */
export async function joinSession(options: JoinOptions): Promise<JoinOutcome> {
  const { sessionId, userId, instanceId, manifest } = options;
  const spectatorsOk = manifest.players.spectators && options.spectatorsAllowed;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const session = await client.query<{ status: string; host_user_id: string | null }>(
      `SELECT status, host_user_id FROM app_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    if (!session.rows[0] || session.rows[0].status !== "live") {
      await client.query("ROLLBACK");
      return { ok: false, code: "ended" };
    }

    const existing = await client.query<{
      seat_id: string;
      role: AppRole;
      left_at: Date | null;
    }>(
      `SELECT seat_id, role, left_at FROM app_session_participants
        WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    const row = existing.rows[0];

    let outcome: JoinOutcome;
    if (row && row.left_at === null) {
      // Still seated, held or not: the same seat, the same role.
      await client.query(
        `UPDATE app_session_participants
            SET orphaned_at = NULL, instance_id = $3
          WHERE session_id = $1 AND user_id = $2`,
        [sessionId, userId, instanceId],
      );
      outcome = { ok: true, seatId: row.seat_id, role: row.role, resumed: true };
    } else {
      const counts = await client.query<{ role: AppRole; n: number }>(
        `SELECT role, count(*)::int AS n FROM app_session_participants
          WHERE session_id = $1 AND left_at IS NULL AND user_id <> $2
          GROUP BY role`,
        [sessionId, userId],
      );
      const seated = (role: AppRole) => counts.rows.find((entry) => entry.role === role)?.n ?? 0;
      const spectatorRoom = seated("spectator") < manifest.players.maxSpectators;

      let role: AppRole | null = null;
      if (options.asSpectator) {
        if (!spectatorsOk) {
          await client.query("ROLLBACK");
          return { ok: false, code: "not-allowed" };
        }
        role = spectatorRoom ? "spectator" : null;
      } else if (seated("player") < manifest.players.max) {
        role = "player";
      } else if (spectatorsOk && spectatorRoom) {
        role = "spectator";
      }
      if (!role) {
        await client.query("ROLLBACK");
        return { ok: false, code: "full" };
      }

      const seatId = row?.seat_id ?? newSeatId();
      if (row) {
        // Left on purpose and back again: the seat id is kept, the place in the
        // line is not (longest seated counts from now).
        await client.query(
          `UPDATE app_session_participants
              SET role = $3, joined_at = NOW(), left_at = NULL, orphaned_at = NULL,
                  instance_id = $4
            WHERE session_id = $1 AND user_id = $2`,
          [sessionId, userId, role, instanceId],
        );
      } else {
        await client.query(
          `INSERT INTO app_session_participants
             (session_id, user_id, seat_id, role, instance_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [sessionId, userId, seatId, role, instanceId],
        );
      }
      outcome = { ok: true, seatId, role, resumed: false };
    }

    // Somebody is here: the empty clock stops, and a host who came back ends
    // the handoff countdown.
    await client.query(
      `UPDATE app_sessions
          SET empty_since = NULL,
              host_gone_at = CASE WHEN host_user_id = $2 THEN NULL ELSE host_gone_at END
        WHERE id = $1`,
      [sessionId, userId],
    );
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Start the empty clock when the last seat is gone. Seats that are only held
 * (orphaned) still count, so a session whose people all reloaded is not empty.
 */
export async function touchEmpty(sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  await getPool().query(
    `UPDATE app_sessions s
        SET empty_since = COALESCE(s.empty_since, NOW())
      WHERE s.id = ANY($1::uuid[]) AND s.status = 'live'
        AND NOT EXISTS (
          SELECT 1 FROM app_session_participants p
           WHERE p.session_id = s.id AND p.left_at IS NULL)`,
    [[...sessionIds]],
  );
}

/**
 * A deployment with no cluster topology (no `VOICE_REGISTRY`, no
 * `CLUSTER_BUS`) is one process, so every seat that names another instance
 * belongs to an earlier run of it that exited without closing its sockets. At
 * boot they become this process's own held seats: a person whose page
 * reconnects resumes the seat inside the window, and the 15 s sweep releases
 * the rest. With a cluster this must NOT run (a sibling's seats are not ours);
 * the dead-instance pass of `apps/sweeps.ts` covers it, from the heartbeats.
 */
export async function adoptPreviousRunSeats(instanceId: string): Promise<number> {
  const result = await getPool().query(
    `UPDATE app_session_participants
        SET instance_id = $1, orphaned_at = COALESCE(orphaned_at, NOW())
      WHERE left_at IS NULL AND instance_id IS DISTINCT FROM $1`,
    [instanceId],
  );
  return result.rowCount ?? 0;
}

/** `app-leave`: the person left on purpose. Not held. True when a seat was released. */
export async function leaveSeat(sessionId: string, userId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE app_session_participants SET left_at = NOW()
      WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [sessionId, userId],
  );
  if (result.rowCount) {
    await touchEmpty([sessionId]);
  }
  return (result.rowCount ?? 0) > 0;
}

/**
 * The person's last socket on this process went away: hold the seat for the
 * resume window. Only a row this process still owns is stamped: if the person
 * joined again from a tab on the other machine, `instance_id` is theirs now and
 * this close changes nothing.
 */
export async function orphanSeat(
  sessionId: string,
  userId: string,
  instanceId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE app_session_participants SET orphaned_at = NOW()
      WHERE session_id = $1 AND user_id = $2 AND instance_id = $3
        AND left_at IS NULL AND orphaned_at IS NULL`,
    [sessionId, userId, instanceId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A person this process holds a live socket for, whose row says orphaned: a
 * tab on the other machine closed and stamped it while this one was still
 * seated. The socket is the evidence; take the seat back.
 */
export async function reclaimLiveSeat(
  sessionId: string,
  userId: string,
  instanceId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE app_session_participants SET orphaned_at = NULL, instance_id = $3
      WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL AND orphaned_at IS NOT NULL`,
    [sessionId, userId, instanceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface OwnSweepResult {
  /** Rows this process owns with no socket behind them, now held for the window. */
  orphaned: Array<{ sessionId: string; userId: string }>;
  /** Held seats past the window, released. */
  released: Array<{ sessionId: string; userId: string }>;
}

/**
 * Every 15 s, over the rows THIS process owns and no others:
 *
 *  - a row that is not orphaned, owned here, whose person has no socket in this
 *    process's map, is a ghost (a close that never reached the row): it is held
 *    for the window like any other close;
 *  - a held row past the window is released.
 *
 * `isLive` answers "does this process hold a socket for this person in this
 * session"; `isJoining` is the grace for a join whose row is written and whose
 * socket is not registered yet. Rows owned by other instances are never read
 * here: judging them from this process's map is pitfall 19.
 */
export async function sweepOwnParticipants(options: {
  instanceId: string;
  now?: Date;
  holdMs?: number;
  isLive: (sessionId: string, userId: string) => boolean;
  isJoining: (sessionId: string, userId: string) => boolean;
}): Promise<OwnSweepResult> {
  const holdMs = options.holdMs ?? APP_ORPHAN_HOLD_MS;
  const now = options.now ?? new Date();
  const result: OwnSweepResult = { orphaned: [], released: [] };

  // Ghosts: rows this process owns that are not held and have no socket here.
  const owned = await getPool().query<{ session_id: string; user_id: string }>(
    `SELECT p.session_id, p.user_id
       FROM app_session_participants p
       JOIN app_sessions s ON s.id = p.session_id AND s.status = 'live'
      WHERE p.instance_id = $1 AND p.left_at IS NULL AND p.orphaned_at IS NULL`,
    [options.instanceId],
  );
  for (const row of owned.rows) {
    if (
      options.isLive(row.session_id, row.user_id) ||
      options.isJoining(row.session_id, row.user_id)
    ) {
      continue;
    }
    if (await orphanSeat(row.session_id, row.user_id, options.instanceId)) {
      result.orphaned.push({ sessionId: row.session_id, userId: row.user_id });
    }
  }

  // Held seats past the window, released in one statement: a person who came
  // back since has cleared `orphaned_at` and is not matched, so the check and
  // the release cannot be split by their return.
  const released = await getPool().query<{ session_id: string; user_id: string }>(
    `UPDATE app_session_participants SET left_at = NOW()
      WHERE instance_id = $1 AND left_at IS NULL
        AND orphaned_at IS NOT NULL AND orphaned_at <= $2::timestamptz
      RETURNING session_id, user_id`,
    [options.instanceId, new Date(now.getTime() - holdMs).toISOString()],
  );
  for (const row of released.rows) {
    result.released.push({ sessionId: row.session_id, userId: row.user_id });
  }
  await touchEmpty([...new Set(result.released.map((entry) => entry.sessionId))]);
  return result;
}

export interface ParticipantRow {
  userId: string;
  seatId: string;
  role: AppRole;
  joinedAt: Date;
  orphanedAt: Date | null;
}

export interface SessionSnapshotRows {
  hostUserId: string | null;
  state: unknown;
  stateRev: number;
  participants: ParticipantRow[];
}

/** The live session's roster, state and host, for a snapshot. Null when it is not live. */
export async function readSessionSnapshotRows(
  sessionId: string,
): Promise<SessionSnapshotRows | null> {
  const [session, people] = await Promise.all([
    getPool().query<{ host_user_id: string | null; state: unknown; state_rev: string }>(
      `SELECT host_user_id, state, state_rev FROM app_sessions
        WHERE id = $1 AND status = 'live'`,
      [sessionId],
    ),
    getPool().query<{
      user_id: string;
      seat_id: string;
      role: AppRole;
      joined_at: Date;
      orphaned_at: Date | null;
    }>(
      `SELECT user_id, seat_id, role, joined_at, orphaned_at
         FROM app_session_participants
        WHERE session_id = $1 AND left_at IS NULL
        ORDER BY joined_at, user_id`,
      [sessionId],
    ),
  ]);
  const row = session.rows[0];
  if (!row) {
    return null;
  }
  return {
    hostUserId: row.host_user_id,
    state: row.state,
    stateRev: Number(row.state_rev),
    participants: people.rows.map((p) => ({
      userId: p.user_id,
      seatId: p.seat_id,
      role: p.role,
      joinedAt: p.joined_at,
      orphanedAt: p.orphaned_at,
    })),
  };
}

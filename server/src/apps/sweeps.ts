import { hasPermission, Permission, type AppEndReason } from "@pqp/shared";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
import { isEnabled } from "../lib/flags.js";
import { claimSingletonTickOrRun } from "../lib/singleton-lease.js";
import { logEvent } from "../lib/log.js";
import { computeMemberPermissions } from "../services/permissions.js";
import { channelVisibleSql } from "../services/users.js";
import {
  INSTANCE_TTL_MS,
  clusterTopologyTracked,
  otherLeasesTrustworthy,
} from "../voice/registry.js";
import { announceChannelApp, announceRoster } from "../ws/apps.js";
import { evaluateAvailability, readAvailabilityRow, readServerFacts } from "./availability.js";
import { APP_HANDOFF_GRACE_MS, pickNextHost } from "./next-host.js";
import { completeHandoff } from "./host.js";
import { loadPinnedManifest } from "./manifests.js";
import {
  recordAppDeadInstanceSeats,
  recordAppHostGone,
  recordAppParticipantsRemoved,
  recordAppSweep,
} from "./metrics.js";
import { APP_ORPHAN_HOLD_MS, touchEmpty } from "./participants.js";
import { endSessionRow } from "./sessions.js";

/**
 * THE SWEEPS OF A LIVE SESSION: everything that ends one, or moves its host, or
 * releases a seat, without a person asking. Registered in `jobs.ts` (runs where
 * the cold jobs run, the worker when there is one, one process per tick under a
 * lease) every 15 s, and safe to run twice at once: every write is a
 * compare-and-set on the state it judged.
 *
 * In this order, each pass seeing what the one before it left:
 *
 *  1. `flag-off`      the `apps` flag is off for the session's server.
 *  2. `app-disabled`  the app is no longer available there: retired, off for
 *                     everyone, not released to the server any more, the owner
 *                     switched it off, the server became a public community
 *                     without the app being unlocked, an emulator app whose
 *                     `emulator_room` went off. The origin and the channel type
 *                     are NOT reasons: a worker with no `APPS_ORIGIN` must not
 *                     end every session on the instance.
 *  3. `max-duration`  twelve hours.
 *  4. Seats lost: a participant who can no longer VIEW the channel (or no
 *     longer CONNECT where the session needs it) is released.
 *  5. Seats of dead instances (pitfall 18): held for 90 s, then released, and
 *     only while this process can believe other instances' leases.
 *  6. The host: no present seat starts `host_gone_at`; after two minutes the
 *     role goes to the longest seated participant who could have started the
 *     app (`hostBound` apps end `host-gone` instead; nobody eligible with people
 *     still seated ends `host-gone`; nobody at all is left to pass 7).
 *  7. `empty`         no seat held for five minutes (counting from the last
 *                     one released, or from the start for a session nobody
 *                     ever joined).
 *
 * A channel that is deleted takes its sessions with it (the foreign key
 * cascades), so the delete route ends them first (`endSessionsOfChannel`) while
 * the channel still exists to tell its viewers.
 */

export const APP_SWEEP_INTERVAL_MS = 15_000;
export const APP_EMPTY_AFTER_MS = 5 * 60_000;
export const APP_MAX_DURATION_MS = 12 * 60 * 60_000;

/** The availability reasons that end a session. The rest are about where it is asked, not whether it may run. */
const ENDING_REASONS = new Set([
  "not-live",
  "global-off",
  "not-allowed-here",
  "owner-off",
  "community-locked",
  "emulator-off",
]);

export interface AppSweepResult {
  ended: Partial<Record<AppEndReason, number>>;
  hostGoneStamped: number;
  handoffs: number;
  participantsRemoved: number;
  deadSeatsHeld: number;
  deadSeatsReleased: number;
}

interface LiveSession {
  id: string;
  server_id: string;
  channel_id: string;
  channel_type: string;
  app_id: string;
  app_version: string;
  host_user_id: string | null;
  host_gone_at: Date | null;
  started_at: Date;
  empty_since: Date | null;
}

/** When this process last failed a sweep: other instances' leases are doubted for a TTL after. */
let lastFailureAt: number | null = null;
/** The next host announced per session, so the countdown is told once and again only when it changes. */
const announcedNext = new Map<string, string | null>();

export function resetAppSweepStateForTests(): void {
  lastFailureAt = null;
  announcedNext.clear();
}

/** Tests: pretend this process's sweep failed at `at` (epoch ms). */
export function noteAppSweepFailureForTests(at: number): void {
  lastFailureAt = at;
}

/** The dead-instance pass: this process can see the database well enough to judge a sibling. */
function deadInstancePassAllowed(nowMs: number): boolean {
  if (!clusterTopologyTracked()) {
    return false;
  }
  if (!otherLeasesTrustworthy(nowMs)) {
    return false;
  }
  return lastFailureAt === null || nowMs - lastFailureAt >= INSTANCE_TTL_MS;
}

export async function runAppSweep(options: { now?: Date } = {}): Promise<AppSweepResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const result: AppSweepResult = {
    ended: {},
    hostGoneStamped: 0,
    handoffs: 0,
    participantsRemoved: 0,
    deadSeatsHeld: 0,
    deadSeatsReleased: 0,
  };

  const live = await getPool().query<LiveSession>(
    `SELECT s.id, s.server_id, s.channel_id, c.type AS channel_type, s.app_id, s.app_version,
            s.host_user_id, s.host_gone_at, s.started_at, s.empty_since
       FROM app_sessions s JOIN channels c ON c.id = s.channel_id
      WHERE s.status = 'live'
      ORDER BY s.started_at, s.id`,
  );
  let sessions = live.rows;

  async function end(session: LiveSession, reason: AppEndReason): Promise<void> {
    try {
      const done = await endSessionRow(session.id, reason, null);
      if (done.ended) {
        result.ended[reason] = (result.ended[reason] ?? 0) + 1;
      }
    } catch (error) {
      logEvent("apps.sweepEndFailed", { sessionId: session.id, reason, error: String(error) });
    }
    sessions = sessions.filter((entry) => entry.id !== session.id);
    announcedNext.delete(session.id);
  }

  // 1 and 2: the platform, then the app, for each server and app once.
  const verdicts = new Map<string, boolean>();
  for (const session of [...sessions]) {
    if (!isEnabled("apps", { serverId: session.server_id })) {
      await end(session, "flag-off");
      continue;
    }
    const key = `${session.server_id}\u0000${session.app_id}`;
    let stillAvailable = verdicts.get(key);
    if (stillAvailable === undefined) {
      const [row, facts] = await Promise.all([
        readAvailabilityRow(session.server_id, session.app_id),
        readServerFacts(session.server_id),
      ]);
      const verdict =
        row && facts
          ? evaluateAvailability(session.server_id, row, facts, { origin: "swept" })
          : { available: false, reason: "not-live" as const };
      stillAvailable = verdict.available || !ENDING_REASONS.has(verdict.reason ?? "");
      verdicts.set(key, stillAvailable);
    }
    if (!stillAvailable) {
      await end(session, "app-disabled");
    }
  }

  // 3: the ceiling.
  for (const session of [...sessions]) {
    if (nowMs - session.started_at.getTime() >= APP_MAX_DURATION_MS) {
      await end(session, "max-duration");
    }
  }

  // 4: seats whose person can no longer be here.
  const removed = await removeParticipantsWhoLostAccess(sessions);
  result.participantsRemoved = removed.length;
  if (removed.length > 0) {
    recordAppParticipantsRemoved(removed.length);
    const bySession = new Map(sessions.map((s) => [s.id, s.channel_id]));
    for (const sessionId of new Set(removed.map((entry) => entry.sessionId))) {
      const channelId = bySession.get(sessionId);
      if (channelId) {
        announceRoster(sessionId, channelId);
      }
    }
    await touchEmpty([...new Set(removed.map((entry) => entry.sessionId))]);
  }

  // 5: the seats of an instance that is gone.
  if (deadInstancePassAllowed(nowMs)) {
    const dead = await sweepDeadInstanceSeats(now);
    result.deadSeatsHeld = dead.held.length;
    result.deadSeatsReleased = dead.released.length;
    const touched = new Set([...dead.held, ...dead.released].map((entry) => entry.sessionId));
    if (touched.size > 0) {
      const bySession = new Map(sessions.map((s) => [s.id, s.channel_id]));
      for (const sessionId of touched) {
        const channelId = bySession.get(sessionId);
        if (channelId) {
          announceRoster(sessionId, channelId);
        }
      }
    }
    if (dead.released.length > 0) {
      await touchEmpty([...new Set(dead.released.map((entry) => entry.sessionId))]);
    }
  }

  // 6: the host.
  for (const session of [...sessions]) {
    await sweepHost(session, now, result, end);
  }

  // 7: nobody here for five minutes.
  const stillLive = await getPool().query<{ id: string }>(
    `SELECT s.id FROM app_sessions s
      WHERE s.status = 'live' AND s.id = ANY($1::uuid[])
        AND COALESCE(s.empty_since, s.started_at) <= $2::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM app_session_participants p
           WHERE p.session_id = s.id AND p.left_at IS NULL)`,
    [sessions.map((s) => s.id), new Date(nowMs - APP_EMPTY_AFTER_MS).toISOString()],
  );
  for (const row of stillLive.rows) {
    const session = sessions.find((entry) => entry.id === row.id);
    if (session) {
      await end(session, "empty");
    }
  }

  return result;
}

/**
 * VIEW_CHANNEL in one statement for everybody seated (the same predicate every
 * read of a channel uses, taking each row's person as the viewer), then CONNECT
 * where the session needs it (a voice channel, or a manifest that asks for it),
 * person by person. A released seat is `left_at`, not held: they did not
 * choose to go.
 */
async function removeParticipantsWhoLostAccess(
  sessions: readonly LiveSession[],
): Promise<Array<{ sessionId: string; userId: string }>> {
  if (sessions.length === 0) {
    return [];
  }
  const ids = sessions.map((s) => s.id);
  const lost = await getPool().query<{ session_id: string; user_id: string }>(
    `WITH seated AS (
       SELECT p.session_id, p.user_id
         FROM app_session_participants p
         JOIN app_sessions s ON s.id = p.session_id
         JOIN channels c ON c.id = s.channel_id
         LEFT JOIN server_members sm
           ON sm.server_id = c.server_id AND sm.user_id = p.user_id
        WHERE s.id = ANY($1::uuid[]) AND p.left_at IS NULL
          AND NOT ${channelVisibleSql("p.user_id")}
     )
     UPDATE app_session_participants p SET left_at = NOW()
       FROM seated
      WHERE p.session_id = seated.session_id AND p.user_id = seated.user_id
        AND p.left_at IS NULL
      RETURNING p.session_id, p.user_id`,
    [ids],
  );
  const removed = lost.rows.map((row) => ({ sessionId: row.session_id, userId: row.user_id }));

  for (const session of sessions) {
    const manifest = await loadPinnedManifest(session.app_id, session.app_version);
    const needsConnect = session.channel_type === "voice" || manifest?.requires.join === "CONNECT";
    if (!needsConnect) {
      continue;
    }
    const seated = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM app_session_participants WHERE session_id = $1 AND left_at IS NULL`,
      [session.id],
    );
    for (const person of seated.rows) {
      const permissions = await computeMemberPermissions(
        session.server_id,
        person.user_id,
        session.channel_id,
      );
      if (hasPermission(permissions, Permission.CONNECT)) {
        continue;
      }
      const gone = await getPool().query(
        `UPDATE app_session_participants SET left_at = NOW()
          WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [session.id, person.user_id],
      );
      if (gone.rowCount) {
        removed.push({ sessionId: session.id, userId: person.user_id });
      }
    }
  }
  return removed;
}

/**
 * Seats owned by an instance whose heartbeat has lapsed (or by no instance at
 * all): held for the resume window the moment they are noticed, released once
 * it is over. Only called while this process can believe the leases
 * (`deadInstancePassAllowed`): a lease that went stale while WE could not see
 * the database is evidence about us, not about the other machine.
 */
async function sweepDeadInstanceSeats(now: Date): Promise<{
  held: Array<{ sessionId: string; userId: string }>;
  released: Array<{ sessionId: string; userId: string }>;
}> {
  const cutoff = new Date(now.getTime() - INSTANCE_TTL_MS).toISOString();
  const owned = `(p.instance_id IS NULL OR (p.instance_id <> $2 AND NOT EXISTS (
        SELECT 1 FROM voice_instances i
         WHERE i.instance_id::text = p.instance_id
           AND i.heartbeat_at >= $3::timestamptz)))`;
  const held = await getPool().query<{ session_id: string; user_id: string }>(
    `UPDATE app_session_participants p SET orphaned_at = $1::timestamptz
      WHERE p.left_at IS NULL AND p.orphaned_at IS NULL AND ${owned}
      RETURNING p.session_id, p.user_id`,
    [now.toISOString(), INSTANCE_ID, cutoff],
  );
  const released = await getPool().query<{ session_id: string; user_id: string }>(
    `UPDATE app_session_participants p SET left_at = $1::timestamptz
      WHERE p.left_at IS NULL AND p.orphaned_at IS NOT NULL
        AND p.orphaned_at <= $4::timestamptz AND ${owned}
      RETURNING p.session_id, p.user_id`,
    [
      now.toISOString(),
      INSTANCE_ID,
      cutoff,
      new Date(now.getTime() - APP_ORPHAN_HOLD_MS).toISOString(),
    ],
  );
  const out = {
    held: held.rows.map((row) => ({ sessionId: row.session_id, userId: row.user_id })),
    released: released.rows.map((row) => ({ sessionId: row.session_id, userId: row.user_id })),
  };
  if (out.held.length) {
    recordAppDeadInstanceSeats("orphaned", out.held.length);
  }
  if (out.released.length) {
    recordAppDeadInstanceSeats("released", out.released.length);
  }
  return out;
}

async function sweepHost(
  session: LiveSession,
  now: Date,
  result: AppSweepResult,
  end: (session: LiveSession, reason: AppEndReason) => Promise<void>,
): Promise<void> {
  const fresh = await getPool().query<{
    host_user_id: string | null;
    host_gone_at: Date | null;
    host_present: boolean;
    seated: number;
  }>(
    `SELECT s.host_user_id, s.host_gone_at,
            EXISTS (SELECT 1 FROM app_session_participants p
                     WHERE p.session_id = s.id AND p.user_id = s.host_user_id
                       AND p.left_at IS NULL AND p.orphaned_at IS NULL) AS host_present,
            (SELECT count(*)::int FROM app_session_participants p
              WHERE p.session_id = s.id AND p.left_at IS NULL) AS seated
       FROM app_sessions s WHERE s.id = $1 AND s.status = 'live'`,
    [session.id],
  );
  const state = fresh.rows[0];
  if (!state) {
    return;
  }

  if (state.host_present) {
    if (state.host_gone_at !== null) {
      // The host is back (or a held seat was reclaimed): the countdown is over.
      await getPool().query(
        `UPDATE app_sessions SET host_gone_at = NULL
          WHERE id = $1 AND status = 'live' AND host_user_id IS NOT DISTINCT FROM $2`,
        [session.id, state.host_user_id],
      );
      announcedNext.delete(session.id);
      void announceChannelApp(session.channel_id, { immediate: true });
    }
    return;
  }

  if (state.host_gone_at === null) {
    const stamped = await getPool().query(
      `UPDATE app_sessions SET host_gone_at = $2::timestamptz
        WHERE id = $1 AND status = 'live' AND host_gone_at IS NULL
          AND host_user_id IS NOT DISTINCT FROM $3`,
      [session.id, now.toISOString(), state.host_user_id],
    );
    if (stamped.rowCount) {
      result.hostGoneStamped += 1;
      recordAppHostGone();
      logEvent("apps.session.hostGone", { sessionId: session.id });
      announcedNext.set(session.id, await pickNextHost(session.id));
      void announceChannelApp(session.channel_id, { immediate: true });
    }
    return;
  }

  // The countdown is running: tell everyone again if who is next changed.
  const next = await pickNextHost(session.id);
  if (!announcedNext.has(session.id) || announcedNext.get(session.id) !== next) {
    announcedNext.set(session.id, next);
    void announceChannelApp(session.channel_id, { immediate: true });
  }

  if (now.getTime() - state.host_gone_at.getTime() < APP_HANDOFF_GRACE_MS) {
    return;
  }
  const manifest = await loadPinnedManifest(session.app_id, session.app_version);
  if (!manifest || manifest.hostBound) {
    await end(session, "host-gone");
    return;
  }
  if (next) {
    if (await completeHandoff(session.id, state.host_user_id, next, "sweep")) {
      result.handoffs += 1;
      announcedNext.delete(session.id);
    }
    return;
  }
  // Nobody is eligible. People still seated (none can host) end it now; a
  // session with nobody left is the empty sweep's, five minutes in.
  if (state.seated > 0) {
    await end(session, "host-gone");
  }
}

/**
 * One tick as the job runs it: one process per tick (a lease, failing open
 * when the database cannot be asked), and a failure never throws into the
 * timer. A failed tick doubts other instances' leases for a TTL.
 */
export async function runAppSweepJob(options: { now?: Date } = {}): Promise<AppSweepResult | null> {
  if (!(await claimSingletonTickOrRun("apps.sweep", APP_SWEEP_INTERVAL_MS - 3_000))) {
    return null;
  }
  try {
    const result = await runAppSweep(options);
    recordAppSweep(true);
    return result;
  } catch (error) {
    lastFailureAt = Date.now();
    recordAppSweep(false);
    logEvent("apps.sweepFailed", { error: String(error) });
    return null;
  }
}

/**
 * Before a channel is deleted: end the live session in it while the channel
 * still exists, so its viewers hear `channel-app` with none and its
 * participants `app-ended` (once the row is gone nobody can say who could see
 * it). The cascade then removes the ended row with the channel.
 */
export async function endSessionsOfChannel(channelId: string): Promise<number> {
  const live = await getPool().query<{ id: string }>(
    `SELECT id FROM app_sessions WHERE channel_id = $1 AND status = 'live'`,
    [channelId],
  );
  let ended = 0;
  for (const row of live.rows) {
    try {
      if ((await endSessionRow(row.id, "channel-gone", null)).ended) {
        ended += 1;
      }
    } catch (error) {
      logEvent("apps.channelGoneEndFailed", { sessionId: row.id, error: String(error) });
    }
  }
  return ended;
}

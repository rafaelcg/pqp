import type { Pool, PoolClient } from "pg";
import type { AppRole, AppSessionSummary } from "@pqp/shared";
import { getPool } from "../db.js";
import { handoffCountdown } from "./next-host.js";

/**
 * What everyone who can view a channel knows about its live app: the card, the
 * strip and the presence line, and nothing a participant alone may see (no
 * state, no seat ids). Always read from the rows, never from an in-process
 * mirror: the row is the truth and any instance can answer for any session.
 *
 * `handoff` is the host's countdown while the host is gone: who is next and
 * when the role moves (`apps/next-host.ts`), null while the host is here.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

interface SessionRow {
  id: string;
  channel_id: string;
  app_id: string;
  app_version: string;
  started_by: string | null;
  host_user_id: string | null;
  started_at: Date;
  host_gone_at: Date | null;
}

interface ParticipantRow {
  session_id: string;
  user_id: string;
  role: AppRole;
  joined_at: Date;
  orphaned_at: Date | null;
}

export type HandoffFor = (session: {
  id: string;
  hostUserId: string | null;
  hostGoneAt: Date;
}) => Promise<{ toUserId: string | null; at: string } | null>;

const SESSION_COLUMNS = `id, channel_id, app_id, app_version, started_by, host_user_id,
       started_at, host_gone_at`;

async function build(
  session: SessionRow,
  rows: ParticipantRow[],
  handoffFor: HandoffFor = handoffCountdown,
): Promise<AppSessionSummary> {
  const participants = rows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
    connection: row.orphaned_at === null ? ("present" as const) : ("reconnecting" as const),
  }));
  const handoff = session.host_gone_at
    ? await handoffFor({
        id: session.id,
        hostUserId: session.host_user_id,
        hostGoneAt: session.host_gone_at,
      })
    : null;
  return {
    id: session.id,
    appId: session.app_id,
    appVersion: session.app_version,
    startedBy: session.started_by,
    hostUserId: session.host_user_id,
    startedAt: session.started_at.toISOString(),
    participants,
    players: participants.filter((p) => p.role === "player").length,
    spectators: participants.filter((p) => p.role === "spectator").length,
    handoff,
  };
}

async function participantsOf(
  db: Queryable,
  sessionIds: readonly string[],
): Promise<Map<string, ParticipantRow[]>> {
  const bySession = new Map<string, ParticipantRow[]>();
  if (sessionIds.length === 0) {
    return bySession;
  }
  const result = await db.query<ParticipantRow>(
    `SELECT session_id, user_id, role, joined_at, orphaned_at
       FROM app_session_participants
      WHERE session_id = ANY($1::uuid[]) AND left_at IS NULL
      ORDER BY joined_at, user_id`,
    [[...sessionIds]],
  );
  for (const row of result.rows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push(row);
    bySession.set(row.session_id, list);
  }
  return bySession;
}

/** The live session of one channel, or null. */
export async function readLiveSummary(
  channelId: string,
  options: { db?: Queryable; handoffFor?: HandoffFor } = {},
): Promise<AppSessionSummary | null> {
  const db = options.db ?? getPool();
  const result = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM app_sessions
      WHERE channel_id = $1 AND status = 'live'`,
    [channelId],
  );
  const session = result.rows[0];
  if (!session) {
    return null;
  }
  const participants = await participantsOf(db, [session.id]);
  return build(session, participants.get(session.id) ?? [], options.handoffFor);
}

/** One session by id, live or not: `null` for a session that is not live. */
export async function readLiveSummaryById(
  sessionId: string,
  options: { db?: Queryable; handoffFor?: HandoffFor } = {},
): Promise<{ channelId: string; summary: AppSessionSummary } | null> {
  const db = options.db ?? getPool();
  const result = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM app_sessions WHERE id = $1 AND status = 'live'`,
    [sessionId],
  );
  const session = result.rows[0];
  if (!session) {
    return null;
  }
  const participants = await participantsOf(db, [session.id]);
  return {
    channelId: session.channel_id,
    summary: await build(session, participants.get(session.id) ?? [], options.handoffFor),
  };
}

/** Every live session of one server, with the channel each one is in. */
export async function readLiveSummariesForServer(
  serverId: string,
  options: { db?: Queryable; handoffFor?: HandoffFor } = {},
): Promise<Array<{ channelId: string; summary: AppSessionSummary }>> {
  const db = options.db ?? getPool();
  const result = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM app_sessions
      WHERE server_id = $1 AND status = 'live'
      ORDER BY started_at, id`,
    [serverId],
  );
  const participants = await participantsOf(
    db,
    result.rows.map((row) => row.id),
  );
  return Promise.all(
    result.rows.map(async (row) => ({
      channelId: row.channel_id,
      summary: await build(row, participants.get(row.id) ?? [], options.handoffFor),
    })),
  );
}

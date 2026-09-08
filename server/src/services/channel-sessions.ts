import {
  CHANNEL_SESSION_NO_SHOW_MINUTES,
  CHANNEL_SESSION_REMINDER_LEAD_MINUTES,
  type ChannelSession,
  type ChannelSessionStatus,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { pushChannelSessionReminder } from "./push.js";
import { forEachAuthenticatedSocket } from "../ws/sockets.js";

/**
 * Watch party scheduling: a session attached to a channel, plus who asked to
 * be reminded about it.
 *
 * TWO REMINDERS, EACH ONE-SHOT. `notified_before_at` fires once at T-10
 * minutes; `notified_live_at` fires once when the session flips live. The
 * minute tick (`sendDueChannelSessionReminders`, called from `jobs.ts`) claims
 * each in the same UPDATE that stamps it, so two overlapping ticks cannot both
 * send the same reminder: the second finds zero rows to claim.
 *
 * LIVE/ENDED ARE DRIVEN BY THE STREAM, NOT THE CLOCK. `markChannelSessionLive`
 * is the seam an actual stream start calls (today: `set-sharing-screen` in
 * ws/voice.ts; the LiveKit/HLS path other work adds can call the same
 * function). `markChannelSessionEnded` is called both when that stream stops
 * and, from the same tick as the reminders, for a `scheduled` session an hour
 * past `starts_at` that never went live at all, a no-show, not a bug.
 */

interface ChannelSessionRow {
  id: string;
  channel_id: string;
  server_id: string | null;
  title: string;
  description: string | null;
  cover_image_key: string | null;
  starts_at: Date;
  status: ChannelSessionStatus;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function mapSession(
  row: ChannelSessionRow,
  reminding: boolean,
): ChannelSession {
  return {
    id: row.id,
    channelId: row.channel_id,
    serverId: row.server_id,
    title: row.title,
    description: row.description,
    // Cover image upload is not wired yet (see the PR notes); the column
    // exists so it can be added without another migration.
    coverImageUrl: null,
    startsAt: row.starts_at.toISOString(),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    reminding,
  };
}

const SESSION_COLUMNS =
  "id, channel_id, server_id, title, description, cover_image_key, starts_at, status, created_by, created_at, updated_at";

export class ChannelSessionError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

async function isReminding(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM channel_session_reminders WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function createChannelSession(input: {
  channelId: string;
  serverId: string | null;
  title: string;
  description: string | null | undefined;
  startsAt: string;
  createdBy: string;
}): Promise<ChannelSession> {
  try {
    const result = await getPool().query<ChannelSessionRow>(
      `INSERT INTO channel_sessions
         (channel_id, server_id, title, description, starts_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SESSION_COLUMNS}`,
      [
        input.channelId,
        input.serverId,
        input.title,
        input.description ?? null,
        input.startsAt,
        input.createdBy,
      ],
    );
    return mapSession(result.rows[0], false);
  } catch (error) {
    // The partial unique index (`status IN ('scheduled', 'live')`) is what
    // throws here; translate it into the same error shape as everything
    // else in this file rather than leaking a raw pg constraint name.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new ChannelSessionError(
        "conflict",
        "This channel already has an upcoming or live session",
      );
    }
    throw error;
  }
}

export async function getChannelSession(
  sessionId: string,
): Promise<ChannelSessionRow | null> {
  const result = await getPool().query<ChannelSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM channel_sessions WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function updateChannelSession(
  sessionId: string,
  requestingUserId: string,
  patch: { title?: string; startsAt?: string; description?: string | null },
): Promise<ChannelSession> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (patch.title !== undefined) {
    sets.push(`title = $${i++}`);
    values.push(patch.title);
  }
  if (patch.startsAt !== undefined) {
    sets.push(`starts_at = $${i++}`);
    values.push(patch.startsAt);
    // Rescheduling un-fires the T-10 reminder so it can fire again against
    // the new time; the live reminder stays one-shot regardless.
    sets.push(`updated_at = NOW()`);
  }
  if (patch.description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(patch.description);
  }
  if (sets.length === 0) {
    const existing = await getChannelSession(sessionId);
    if (!existing) {
      throw new ChannelSessionError("not_found", "Session not found");
    }
    return mapSession(existing, await isReminding(sessionId, requestingUserId));
  }
  values.push(sessionId);
  const result = await getPool().query<ChannelSessionRow>(
    `UPDATE channel_sessions SET ${sets.join(", ")}
      WHERE id = $${i} AND status = 'scheduled'
      RETURNING ${SESSION_COLUMNS}`,
    values,
  );
  if (result.rows.length === 0) {
    throw new ChannelSessionError(
      "not_found",
      "Session not found, or is no longer scheduled",
    );
  }
  if (patch.startsAt !== undefined) {
    await getPool().query(
      `UPDATE channel_session_reminders
          SET notified_before_at = NULL
        WHERE session_id = $1`,
      [sessionId],
    );
  }
  return mapSession(
    result.rows[0],
    await isReminding(sessionId, requestingUserId),
  );
}

export async function cancelChannelSession(sessionId: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE channel_sessions SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND status IN ('scheduled', 'live')`,
    [sessionId],
  );
  if (result.rowCount === 0) {
    throw new ChannelSessionError("not_found", "Session not found");
  }
}

export async function listUpcomingChannelSessions(
  channelId: string,
  userId: string,
): Promise<ChannelSession[]> {
  const result = await getPool().query<
    ChannelSessionRow & { reminding: boolean }
  >(
    `SELECT s.*, EXISTS (
        SELECT 1 FROM channel_session_reminders r
         WHERE r.session_id = s.id AND r.user_id = $2
      ) AS reminding
       FROM channel_sessions s
      WHERE s.channel_id = $1 AND s.status IN ('scheduled', 'live')
      ORDER BY s.starts_at ASC`,
    [channelId, userId],
  );
  return result.rows.map((row) => mapSession(row, row.reminding));
}

export async function listUpcomingChannelSessionsForServer(
  serverId: string,
  userId: string,
): Promise<ChannelSession[]> {
  const result = await getPool().query<
    ChannelSessionRow & { reminding: boolean }
  >(
    `SELECT s.*, EXISTS (
        SELECT 1 FROM channel_session_reminders r
         WHERE r.session_id = s.id AND r.user_id = $2
      ) AS reminding
       FROM channel_sessions s
      WHERE s.server_id = $1 AND s.status IN ('scheduled', 'live')
      ORDER BY s.starts_at ASC`,
    [serverId, userId],
  );
  return result.rows.map((row) => mapSession(row, row.reminding));
}

export async function setChannelSessionReminder(
  sessionId: string,
  userId: string,
  wants: boolean,
): Promise<void> {
  if (wants) {
    await getPool().query(
      `INSERT INTO channel_session_reminders (session_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [sessionId, userId],
    );
  } else {
    await getPool().query(
      `DELETE FROM channel_session_reminders WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
  }
}

/**
 * The seam a stream start calls. Idempotent: a session already live or past
 * scheduling is left alone, so a second screen-share in the same room is a
 * no-op rather than a re-fire of the live reminder.
 */
export async function markChannelSessionLive(
  channelId: string,
): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE channel_sessions SET status = 'live', updated_at = NOW()
      WHERE channel_id = $1 AND status = 'scheduled'
      RETURNING id`,
    [channelId],
  );
  return result.rows[0]?.id ?? null;
}

/** The seam a stream stop calls. */
export async function markChannelSessionEnded(
  channelId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE channel_sessions SET status = 'ended', updated_at = NOW()
      WHERE channel_id = $1 AND status = 'live'`,
    [channelId],
  );
}

// ------------------------------------------------------------ the minute tick

/**
 * Called every minute from `jobs.ts`. Three independent claims, each an
 * UPDATE that only the winning tick can affect:
 *
 *  1. Sessions crossing the no-show line (`scheduled`, an hour past
 *     `starts_at`, nobody ever went live) become `ended`.
 *  2. Reminders whose T-10 instant has arrived get `notified_before_at`
 *     stamped, and everyone still subscribed is pushed.
 *  3. Reminders on a session that just went live get `notified_live_at`
 *     stamped and pushed, once, per subscriber, ever, not once per tick
 *     while the session stays live.
 */
export async function sendDueChannelSessionReminders(): Promise<void> {
  await noShowSweep();
  await fireReminders("before");
  await fireReminders("live");
}

async function noShowSweep(): Promise<void> {
  await getPool().query(
    `UPDATE channel_sessions SET status = 'ended', updated_at = NOW()
      WHERE status = 'scheduled'
        AND starts_at < NOW() - ($1 || ' minutes')::interval`,
    [String(CHANNEL_SESSION_NO_SHOW_MINUTES)],
  );
}

async function fireReminders(kind: "before" | "live"): Promise<void> {
  const column = kind === "before" ? "notified_before_at" : "notified_live_at";
  const statusFilter = kind === "before" ? "'scheduled'" : "'live'";
  const dueCondition =
    kind === "before"
      ? `s.starts_at <= NOW() + ($1 || ' minutes')::interval`
      : `s.status = 'live'`;
  const params = kind === "before" ? [String(CHANNEL_SESSION_REMINDER_LEAD_MINUTES)] : [];

  const claimed = await getPool().query<{
    session_id: string;
    user_id: string;
    title: string;
    channel_id: string;
    starts_at: Date;
  }>(
    `UPDATE channel_session_reminders r
        SET ${column} = NOW()
       FROM channel_sessions s
      WHERE r.session_id = s.id
        AND r.${column} IS NULL
        AND s.status IN (${statusFilter})
        AND ${dueCondition}
      RETURNING r.session_id, r.user_id, s.title, s.channel_id, s.starts_at`,
    params,
  );

  if (claimed.rows.length === 0) {
    return;
  }

  const bySession = new Map<
    string,
    { title: string; channelId: string; startsAt: Date; userIds: string[] }
  >();
  for (const row of claimed.rows) {
    const existing = bySession.get(row.session_id);
    if (existing) {
      existing.userIds.push(row.user_id);
    } else {
      bySession.set(row.session_id, {
        title: row.title,
        channelId: row.channel_id,
        startsAt: row.starts_at,
        userIds: [row.user_id],
      });
    }
  }

  for (const [sessionId, session] of bySession) {
    notifyChannelSessionSubscribers({
      sessionId,
      channelId: session.channelId,
      title: session.title,
      startsAt: session.startsAt.toISOString(),
      userIds: session.userIds,
      kind,
    });
  }
}

function notifyChannelSessionSubscribers(event: {
  sessionId: string;
  channelId: string;
  title: string;
  startsAt: string;
  userIds: string[];
  kind: "before" | "live";
}): void {
  const recipients = new Set(event.userIds);
  // Live WS nudge for whoever is connected on this process. In the
  // single-process deployment (`WORKER_MODE` unset, today's default) this is
  // every online recipient; in a split worker it is a harmless no-op loop
  // over zero sockets, and push (below) is what reaches them instead.
  const frame = JSON.stringify({
    type: "channel-session-reminder",
    sessionId: event.sessionId,
    channelId: event.channelId,
    title: event.title,
    startsAt: event.startsAt,
    kind: event.kind,
  });
  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState === 1 && recipients.has(user.id)) {
      socket.send(frame);
    }
  });

  pushChannelSessionReminder({
    userIds: [...recipients],
    title: event.title,
    channelId: event.channelId,
    kind: event.kind,
  });
}

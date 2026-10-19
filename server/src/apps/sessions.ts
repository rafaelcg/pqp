import {
  APP_RESULT_MAX_BYTES,
  hasPermission,
  Permission,
  type AppEnded,
  type AppEndReason,
  type AppSessionSummary,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool, type DbUser } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { HttpError } from "../lib/http.js";
import { logEvent } from "../lib/log.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { HttpErrorWithDetail } from "../lib/route-results.js";
import { announceAppEnded, announceChannelApp } from "../ws/apps.js";
import { announceServiceMessage } from "../ws/chat.js";
import { getHydratedMessage, invalidateLatestMessages, mapMessage } from "../services/messages.js";
import { computeMemberPermissions } from "../services/permissions.js";
import { isInstanceModerator } from "../services/reports.js";
import { getChannel } from "../services/servers.js";
import { canAccessChannel } from "../services/users.js";
import {
  evaluateAvailability,
  manifestOfRow,
  readAvailabilityRow,
  readServerFacts,
} from "./availability.js";
import { recordAppEnd, recordAppStart, recordAppStartRefused } from "./metrics.js";
import { retryAfterCommit } from "./post-commit-retry.js";
import { readLiveSummary, readLiveSummaryById } from "./summary.js";

/**
 * THE SESSION LIFECYCLE: start, end. (Joining, state and events are the
 * socket's, `ws/apps.ts`; the sweeps that end a session on their own are
 * `apps/sweeps.ts`.)
 *
 * One live session per channel, decided by the partial unique index
 * `idx_app_sessions_one_live_per_channel`: two starts at once, on one machine
 * or two, produce one session and one 409 carrying the winner's summary,
 * because the INSERT is what races and Postgres is what picks.
 *
 * `app_sessions.server_id` is taken from the channel row this module loaded,
 * never from anything the request said.
 */

/** What a route needs from a person to act as them. */
export type AppSessionUser = Pick<DbUser, "id" | "clerk_id" | "display_name">;

/**
 * Starts per person: a burst of six, then one every ten seconds. Every start
 * writes a timeline message to the whole channel, so start, end, start, end is
 * a way to fill somebody's chat. Per process, which is enough for a backstop
 * whose job is the channel, not fairness. Spent only by a start that is about
 * to be written, never by a refusal.
 */
const startLimiter = createRateLimiter({ capacity: 6, refillPerSecond: 0.1 });

export function resetAppSessionLimitsForTests(): void {
  startLimiter.reset();
}

const notFoundChannel = () => new HttpError(404, "Channel not found");
const notFoundSession = () => new HttpError(404, "Session not found");

/** One line a client that predates the kind renders in the timeline. */
export function appSessionFallbackBody(displayName: string): string {
  const clean = displayName.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim();
  return `${clean || "?"} começou um app`;
}

async function nicknameIn(
  client: Pick<PoolClient, "query">,
  serverId: string,
  userId: string,
): Promise<string | null> {
  const result = await client.query<{ nickname: string | null }>(
    `SELECT nickname FROM server_members WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
  return result.rows[0]?.nickname || null;
}

const LIVE_INDEX = "idx_app_sessions_one_live_per_channel";

function isLiveSessionConflict(error: unknown): boolean {
  const pg = error as { code?: string; constraint?: string } | null;
  return pg?.code === "23505" && pg.constraint === LIVE_INDEX;
}

async function sessionLive(summary: AppSessionSummary | null): Promise<never> {
  throw new HttpErrorWithDetail(409, "session_live", { session: summary });
}

/**
 * Start `appId` in `channelId` as `user`. The checks, in this order, each one
 * refusing before the next is asked:
 *
 *  1. the channel exists, is a server channel and the person can VIEW it (404);
 *  2. the runtime flag `apps` for the channel's server (404);
 *  3. the app is available there, for this channel's type (403 `app_unavailable`
 *     with the `reason`);
 *  4. the person holds the manifest's `requires.start` in THIS channel, USE_APPS
 *     always, honouring channel overwrites (403 `cannot_start`);
 *  5. no live session: the unique index decides (409 `session_live`).
 *
 * The starter becomes host and is NOT joined: the client joins over `/ws`
 * right after.
 */
export async function startAppSession(
  user: AppSessionUser,
  channelId: string,
  appId: string,
): Promise<AppSessionSummary> {
  const channel = await getChannel(channelId);
  if (!channel || channel.kind !== "server" || !channel.server_id) {
    throw notFoundChannel();
  }
  if (!(await canAccessChannel(channelId, user.id))) {
    throw notFoundChannel();
  }
  const serverId = channel.server_id;
  if (!isEnabled("apps", { serverId })) {
    throw notFoundChannel();
  }

  const [row, facts] = await Promise.all([
    readAvailabilityRow(serverId, appId),
    readServerFacts(serverId),
  ]);
  const verdict =
    row && facts
      ? evaluateAvailability(serverId, row, facts, { channelType: channel.type })
      : { available: false, reason: "not-live" as const };
  if (!verdict.available || !row) {
    const reason = verdict.reason ?? "not-live";
    recordAppStartRefused(reason);
    throw new HttpErrorWithDetail(403, "app_unavailable", { reason });
  }
  const manifest = manifestOfRow(row);
  if (!manifest) {
    recordAppStartRefused("not-live");
    throw new HttpErrorWithDetail(403, "app_unavailable", { reason: "not-live" });
  }

  const permissions = await computeMemberPermissions(serverId, user.id, channelId);
  const allowed =
    hasPermission(permissions, Permission.USE_APPS) &&
    (manifest.requires.start !== "MANAGE_CHANNELS" ||
      hasPermission(permissions, Permission.MANAGE_CHANNELS));
  if (!allowed) {
    recordAppStartRefused("cannot_start");
    throw new HttpError(403, "cannot_start");
  }

  const existing = await readLiveSummary(channelId);
  if (existing) {
    recordAppStartRefused("session_live");
    return sessionLive(existing);
  }

  if (!startLimiter.take(user.id)) {
    recordAppStartRefused("rate_limited");
    throw new HttpError(429, "rate_limited");
  }

  const client = await getPool().connect();
  let sessionId: string;
  let messageId: string;
  let pinnedVersion: string;
  let startedAt: Date;
  try {
    await client.query("BEGIN");
    // The version is whatever `current_version` is at this instant, and the row
    // takes its `server_id` from the channel loaded above.
    const inserted = await client.query<{ id: string; app_version: string; started_at: Date }>(
      `INSERT INTO app_sessions (server_id, channel_id, app_id, app_version, started_by, host_user_id)
       SELECT $1, $2, a.id, a.current_version, $3, $3
         FROM apps a
        WHERE a.id = $4 AND a.status = 'live' AND a.current_version IS NOT NULL
          -- The gates are asked again INSIDE the write, not only before it: an
          -- operator or owner switch, or a community lock, that moved while the
          -- checks above ran stops this insert.
          AND a.global_enabled
          AND EXISTS (SELECT 1 FROM server_apps sa
                       WHERE sa.server_id = $1 AND sa.app_id = a.id
                         AND sa.operator_enabled IS TRUE AND sa.owner_enabled IS NOT FALSE)
          AND (a.community_unlocked
               OR NOT COALESCE((SELECT is_community FROM servers WHERE id = $1), FALSE))
       RETURNING id, app_version, started_at`,
      [serverId, channelId, user.id, appId],
    );
    if (!inserted.rows[0]) {
      await client.query("ROLLBACK");
      recordAppStartRefused("not-live");
      throw new HttpErrorWithDetail(403, "app_unavailable", { reason: "not-live" });
    }
    sessionId = inserted.rows[0].id;
    pinnedVersion = inserted.rows[0].app_version;
    startedAt = inserted.rows[0].started_at;
    const displayName = (await nicknameIn(client, serverId, user.id)) ?? user.display_name;
    const message = await client.query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body, system_kind)
       VALUES ($1, $2, $3, 'app_session')
       RETURNING id`,
      [channelId, user.id, appSessionFallbackBody(displayName)],
    );
    messageId = message.rows[0]!.id;
    await client.query(`UPDATE app_sessions SET timeline_message_id = $2 WHERE id = $1`, [
      sessionId,
      messageId,
    ]);
    // The runtime flag last, in memory, as close to the commit as it gets: a
    // server switched off while this ran gets nothing.
    if (!isEnabled("apps", { serverId })) {
      await client.query("ROLLBACK");
      throw notFoundChannel();
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (isLiveSessionConflict(error)) {
      recordAppStartRefused("session_live");
      return sessionLive(await readLiveSummary(channelId));
    }
    throw error;
  } finally {
    client.release();
  }

  recordAppStart();
  logEvent("apps.session.started", { sessionId, appId, channelId, serverId });

  // After the commit, and each leg on its own: a failure to tell people is
  // logged and never undoes (or re-answers) a session that exists.
  invalidateLatestMessages(channelId);
  // The card's broadcast is tried once inline, so in the usual case it reaches
  // the channel before the `channel-app` frame. A read that fails (a pool blip,
  // or the database gone for a while) hands it to `retryAfterCommit`, which
  // keeps trying in the background without holding this answer, waits out an
  // open database breaker instead of spending attempts on it, and gives up only
  // past its horizon, so the channel is not left without the card until
  // somebody reloads.
  const announceCard = async () => {
    const hydrated = await getHydratedMessage(messageId);
    if (hydrated) {
      await announceServiceMessage(mapMessage(hydrated));
    }
  };
  try {
    await announceCard();
  } catch (error) {
    logEvent("apps.timelineAnnounceFailed", { sessionId, attempt: 0, error: String(error) });
    void retryAfterCommit(announceCard, {
      event: "apps.timelineAnnounceFailed",
      key: `card:${sessionId}`,
      fields: { sessionId },
    });
  }
  void announceChannelApp(channelId, { immediate: true }).catch(() => {});

  // The answer is THIS session's: read by its id, never by channel (another
  // start could have won the channel since). The session and its card already
  // exist, so a database that cannot be read now must not turn a committed
  // start into a failed one: the answer is then built from what the insert
  // returned, which is exactly what a session nobody has joined looks like.
  try {
    const read = await readLiveSummaryById(sessionId);
    if (!read) {
      // Ended between the commit and this read; the end already told everyone.
      throw new HttpErrorWithDetail(409, "session_ended", { session: null });
    }
    return read.summary;
  } catch (error) {
    if (error instanceof HttpErrorWithDetail) {
      throw error;
    }
    logEvent("apps.startSummaryUnread", { sessionId, error: String(error) });
    return {
      id: sessionId,
      appId,
      appVersion: pinnedVersion,
      startedBy: user.id,
      hostUserId: user.id,
      startedAt: startedAt.toISOString(),
      participants: [],
      players: 0,
      spectators: 0,
      handoff: null,
    };
  }
}

/**
 * The result an ending app may keep: a plain JSON object of at most
 * `APP_RESULT_MAX_BYTES` compact bytes, without a character Postgres cannot
 * store. Anything else is dropped (null), never an error: an ending is not the
 * place to refuse.
 */
export function keptResult(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > APP_RESULT_MAX_BYTES || text.includes("\\u0000")) {
    return null;
  }
  return value as Record<string, unknown>;
}

export interface EndedSession {
  /** False when it was already over: nothing was written and nobody was told. */
  ended: boolean;
  channelId: string | null;
}

/**
 * End a session by id, for whatever `reason`, as `endedBy` (null for the
 * system). The one place a session ends, shared by the person's route and the
 * sweeps. Idempotent: ending a session that is not live is a no-op.
 *
 * Clears the state, writes `{ participants, durationSeconds }` into `summary`,
 * stamps everyone still seated as having left, and after the commit tells the
 * participants (`app-ended`) and the channel's viewers (`channel-app` with no
 * session), on every machine.
 */
export async function endSessionRow(
  sessionId: string,
  reason: AppEndReason,
  endedBy: string | null,
): Promise<EndedSession> {
  const client = await getPool().connect();
  let ended: {
    channel_id: string;
    summary: { participants: number; durationSeconds: number; result?: unknown };
  } | null = null;
  try {
    await client.query("BEGIN");
    // What the app left in `state.result` (a closed vote's tally) outlives the
    // state: copied into the summary when it is a small JSON object, dropped
    // when it is anything else. Read under the row's lock so a write that lands
    // while the session ends is either in it or after the end refuses it.
    const locked = await client.query<{ result: unknown }>(
      `SELECT state->'result' AS result FROM app_sessions
        WHERE id = $1 AND status = 'live' FOR UPDATE`,
      [sessionId],
    );
    const kept = keptResult(locked.rows[0]?.result);
    const result = await client.query<{
      channel_id: string;
      summary: { participants: number; durationSeconds: number; result?: unknown };
    }>(
      `UPDATE app_sessions s
          SET status = 'ended', ended_at = NOW(), end_reason = $2, ended_by = $3,
              state = '{}'::jsonb,
              summary = jsonb_build_object(
                'participants',
                (SELECT count(*)::int FROM app_session_participants p WHERE p.session_id = s.id),
                'durationSeconds',
                GREATEST(0, floor(extract(epoch FROM (NOW() - s.started_at)))::int))
              || CASE WHEN $4::jsonb IS NULL THEN '{}'::jsonb
                      ELSE jsonb_build_object('result', $4::jsonb) END
        WHERE s.id = $1 AND s.status = 'live'
        RETURNING s.channel_id, s.summary`,
      [sessionId, reason, endedBy, kept === null ? null : JSON.stringify(kept)],
    );
    ended = result.rows[0] ?? null;
    if (ended) {
      await client.query(
        `UPDATE app_session_participants SET left_at = NOW()
          WHERE session_id = $1 AND left_at IS NULL`,
        [sessionId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (!ended) {
    return { ended: false, channelId: null };
  }
  recordAppEnd(reason);
  logEvent("apps.session.ended", { sessionId, reason, channelId: ended.channel_id });
  await announceAppEnded({
    type: "app-ended",
    sessionId,
    channelId: ended.channel_id,
    reason,
    summary: ended.summary as AppEnded["summary"],
  });
  void announceChannelApp(ended.channel_id, { immediate: true }).catch(() => {});
  return { ended: true, channelId: ended.channel_id };
}

/**
 * `POST /api/app-sessions/:id/end` as a person. Who may: the host (`host`),
 * somebody holding MANAGE_CHANNELS in the channel (`moderator`), or an
 * instance moderator (`operator`). The session is invisible (404) to anybody
 * who cannot VIEW its channel, an instance moderator excepted, and to every
 * server whose `apps` flag is off.
 */
export async function endAppSessionAs(
  user: AppSessionUser,
  sessionId: string,
): Promise<EndedSession> {
  const result = await getPool().query<{
    server_id: string;
    channel_id: string;
    host_user_id: string | null;
  }>(`SELECT server_id, channel_id, host_user_id FROM app_sessions WHERE id = $1`, [sessionId]);
  const row = result.rows[0];
  if (!row) {
    throw notFoundSession();
  }
  if (!isEnabled("apps", { serverId: row.server_id })) {
    throw notFoundSession();
  }
  const operator = isInstanceModerator(user);
  if (!operator && !(await canAccessChannel(row.channel_id, user.id))) {
    throw notFoundSession();
  }

  let reason: AppEndReason | null = null;
  if (row.host_user_id === user.id) {
    reason = "host";
  } else {
    const permissions = await computeMemberPermissions(row.server_id, user.id, row.channel_id);
    if (hasPermission(permissions, Permission.MANAGE_CHANNELS)) {
      reason = "moderator";
    } else if (operator) {
      reason = "operator";
    }
  }
  if (!reason) {
    throw new HttpError(403, "cannot_end");
  }
  return endSessionRow(sessionId, reason, user.id);
}

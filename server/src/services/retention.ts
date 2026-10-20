import { getPool } from "../db.js";

/** One DELETE this size at a time, so a server with years of backlog the
 * first time retention is turned on does not hold a single transaction open
 * over an unbounded row count. */
const BATCH_SIZE = 500;

/** Batches per server per sweep tick — a backstop, not a real limit: at
 * BATCH_SIZE * this ceiling per server per day, a server would need to be
 * aging past its own retention window faster than one sweep can keep up,
 * which is not a real workload for this product. Existing backlog just
 * finishes draining on the next tick instead of blocking this one. */
const MAX_BATCHES_PER_SERVER = 20;

/**
 * Delete messages older than each server's own `message_retention_days`,
 * server by server, batch by batch. Pinned messages are exempt — a pin is an
 * explicit "keep this," and retention silently taking one away would be a
 * surprise nobody asked for.
 *
 * A forum post's opening message is exempt too: it is the question the post
 * exists for, and sweeping it would leave a title over a list of orphaned
 * answers. Its replies age out like any other message. The probe goes through
 * `forum_posts`' primary key (`channel_id`), so it costs nothing on the
 * channels that are not posts.
 *
 * No broadcast, unlike a moderator's delete: these are, by definition,
 * messages nobody currently has open (they are older than the server's own
 * retention window), so there is nothing live to reconcile. The orphaned
 * attachments this leaves behind are swept by the existing hourly
 * `sweepOrphanedAttachments` job, not duplicated here.
 *
 * Not logged to `audit_log` either — a scheduled system action has no actor,
 * and the log exists to answer "who did this," not "what expired."
 */
export async function sweepMessageRetention(): Promise<number> {
  const servers = await getPool().query<{
    id: string;
    message_retention_days: number;
  }>(`SELECT id, message_retention_days FROM servers WHERE message_retention_days IS NOT NULL`);

  let totalDeleted = 0;
  for (const server of servers.rows) {
    for (let batch = 0; batch < MAX_BATCHES_PER_SERVER; batch++) {
      const result = await getPool().query(
        `DELETE FROM messages
         WHERE id IN (
           SELECT m.id FROM messages m
           JOIN channels c ON c.id = m.channel_id
           WHERE c.server_id = $1
             AND m.pinned_at IS NULL
             AND m.created_at < NOW() - ($2 || ' days')::interval
             AND NOT EXISTS (
               SELECT 1 FROM forum_posts fp
                WHERE fp.channel_id = m.channel_id
                  AND fp.opening_message_id = m.id
             )
           LIMIT $3
         )`,
        [server.id, server.message_retention_days, BATCH_SIZE],
      );
      const deleted = result.rowCount ?? 0;
      totalDeleted += deleted;
      if (deleted < BATCH_SIZE) {
        break;
      }
    }
  }
  return totalDeleted;
}

/** Ended app sessions are kept this long: enough for a report to name one. */
export const APP_SESSION_RETENTION_DAYS = 30;

/**
 * Delete app sessions that ended more than 30 days ago, 500 at a time (their
 * participant rows go with them through the foreign key). What stays: the
 * timeline message, which keeps its generic card ("terminou"), and nothing
 * else about the session. Live sessions are never touched, however old: the
 * 12 hour sweep ends them first. Returns how many were deleted.
 */
export async function sweepAppSessionRetention(): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_SERVER; batch++) {
    const result = await getPool().query(
      `DELETE FROM app_sessions
        WHERE id IN (
          SELECT id FROM app_sessions
           WHERE status = 'ended'
             AND ended_at < NOW() - ($1 || ' days')::interval
           ORDER BY ended_at
           LIMIT $2
        )`,
      [String(APP_SESSION_RETENTION_DAYS), BATCH_SIZE],
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < BATCH_SIZE) {
      break;
    }
  }
  return total;
}

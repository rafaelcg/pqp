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

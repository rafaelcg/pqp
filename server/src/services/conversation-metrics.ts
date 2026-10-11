import { getPool } from "../db.js";

/**
 * `conversations` on `GET /api/admin/metrics`: is pqp being used to talk to
 * people, and not only in servers.
 *
 * Conversas (the DM redesign, flag `conversations_home`) is judged on one
 * ratio, `senders7d / activeSenders7d`: of the people who wrote anything this
 * week, how many wrote to somebody in a conversation. Both halves come from the
 * same query so they cannot be read at two different moments. Everything here
 * counts humans only (no webhook, no house cast) and comes from the database,
 * so it is the same on every replica and survives a deploy.
 *
 * "Conversation" is `channels.kind IN ('dm', 'group')`, the same split
 * `messages.byScope24h` uses.
 */
export interface ConversationMetrics {
  /** Distinct humans who sent a DM or group message in the last 24 hours. */
  senders1d: number;
  /** The same over 7 days: the numerator of the ratio above. */
  senders7d: number;
  /** Distinct humans who sent any message in the last 7 days: its denominator. */
  activeSenders7d: number;
  /** Conversations opened in the last 24 hours, by kind. A reopened 1:1 is not new. */
  created24h: { dm: number; group: number };
  /**
   * Accounts created 8 to 14 days ago (so their first week is over) and how
   * many of them sent a DM or group message inside that first week.
   */
  newcomers: { eligible: number; dmWithin7d: number };
}

export async function conversationMetrics(): Promise<ConversationMetrics> {
  const pool = getPool();
  const [senders, created, newcomers] = await Promise.all([
    pool.query<{ d1: string; d7: string; active7d: string }>(
      `SELECT COUNT(DISTINCT m.author_id) FILTER (
                WHERE c.kind <> 'server' AND m.created_at >= now() - interval '24 hours'
              )::text AS d1,
              COUNT(DISTINCT m.author_id) FILTER (WHERE c.kind <> 'server')::text AS d7,
              COUNT(DISTINCT m.author_id)::text AS active7d
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         JOIN users u ON u.id = m.author_id
        WHERE m.created_at >= now() - interval '7 days'
          AND NOT u.is_webhook AND NOT u.is_character`,
    ),
    pool.query<{ kind: string; n: string }>(
      `SELECT kind, COUNT(*)::text AS n
         FROM channels
        WHERE kind <> 'server'
          AND created_at >= now() - interval '24 hours'
        GROUP BY kind`,
    ),
    // Index-shaped on both sides: users by created_at is a small window, and
    // the EXISTS walks `messages (author_id, created_at, id)` per account.
    pool.query<{ eligible: string; dm_within7d: string }>(
      `SELECT COUNT(*)::text AS eligible,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1
                  FROM messages m
                  JOIN channels c ON c.id = m.channel_id
                 WHERE m.author_id = u.id
                   AND c.kind <> 'server'
                   AND m.created_at < u.created_at + interval '7 days'
              ))::text AS dm_within7d
         FROM users u
        WHERE u.created_at >= now() - interval '14 days'
          AND u.created_at < now() - interval '8 days'
          AND NOT u.is_webhook AND NOT u.is_character`,
    ),
  ]);

  const byKind = new Map(created.rows.map((row) => [row.kind, Number(row.n)]));
  const s = senders.rows[0];
  const n = newcomers.rows[0];
  return {
    senders1d: Number(s?.d1 ?? 0),
    senders7d: Number(s?.d7 ?? 0),
    activeSenders7d: Number(s?.active7d ?? 0),
    created24h: { dm: byKind.get("dm") ?? 0, group: byKind.get("group") ?? 0 },
    newcomers: {
      eligible: Number(n?.eligible ?? 0),
      dmWithin7d: Number(n?.dm_within7d ?? 0),
    },
  };
}

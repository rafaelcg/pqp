import { getPool } from "../db.js";

export interface ReactionSummary {
  emoji: string;
  count: number;
  me: boolean;
}

export async function listReactionsForMessages(
  messageIds: string[],
  viewerId?: string,
): Promise<Map<string, ReactionSummary[]>> {
  const byMessage = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) {
    return byMessage;
  }

  const result = await getPool().query<{
    message_id: string;
    emoji: string;
    count: string;
    me: boolean;
  }>(
    `SELECT message_id,
            emoji,
            COUNT(*)::text AS count,
            BOOL_OR(user_id IS NOT DISTINCT FROM $2) AS me
     FROM message_reactions
     WHERE message_id = ANY($1::uuid[])
     GROUP BY message_id, emoji
     ORDER BY MIN(created_at) ASC`,
    [messageIds, viewerId ?? null],
  );

  for (const row of result.rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push({
      emoji: row.emoji,
      count: Number(row.count),
      me: Boolean(row.me),
    });
    byMessage.set(row.message_id, list);
  }

  return byMessage;
}

export async function getMessageChannelId(
  messageId: string,
): Promise<string | null> {
  const result = await getPool().query<{ channel_id: string }>(
    `SELECT channel_id FROM messages WHERE id = $1`,
    [messageId],
  );
  return result.rows[0]?.channel_id ?? null;
}

export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ added: boolean }> {
  const existing = await getPool().query(
    `SELECT 1 FROM message_reactions
     WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
    [messageId, userId, emoji],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    await getPool().query(
      `DELETE FROM message_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, userId, emoji],
    );
    return { added: false };
  }

  await getPool().query(
    `INSERT INTO message_reactions (message_id, user_id, emoji)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
    [messageId, userId, emoji],
  );
  return { added: true };
}

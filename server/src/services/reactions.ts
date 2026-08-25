import { getPool } from "../db.js";

/** First reactors named on the wire. `count` is still the full total. */
export const REACTION_NAMED_USER_LIMIT = 20;

export interface ReactionUser {
  id: string;
  displayName: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  me: boolean;
  users: ReactionUser[];
}

export interface ReactionRow {
  message_id: string;
  emoji: string;
  user_id: string;
  display_name: string;
}

export function summariseReactionRows(
  rows: ReactionRow[],
  viewerId?: string,
  namedLimit = REACTION_NAMED_USER_LIMIT,
): Map<string, ReactionSummary[]> {
  const grouped = new Map<string, Map<string, ReactionSummary>>();
  for (const row of rows) {
    let byEmoji = grouped.get(row.message_id);
    if (!byEmoji) {
      byEmoji = new Map();
      grouped.set(row.message_id, byEmoji);
    }
    let summary = byEmoji.get(row.emoji);
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, me: false, users: [] };
      byEmoji.set(row.emoji, summary);
    }
    summary.count += 1;
    if (viewerId && row.user_id === viewerId) {
      summary.me = true;
    }
    if (summary.users.length < namedLimit) {
      summary.users.push({
        id: row.user_id,
        displayName: row.display_name,
      });
    }
  }

  const byMessage = new Map<string, ReactionSummary[]>();
  for (const [messageId, byEmoji] of grouped) {
    byMessage.set(messageId, [...byEmoji.values()]);
  }
  return byMessage;
}

export async function listReactionsForMessages(
  messageIds: string[],
  viewerId?: string,
): Promise<Map<string, ReactionSummary[]>> {
  if (messageIds.length === 0) {
    return new Map();
  }

  const result = await getPool().query<ReactionRow>(
    `SELECT r.message_id,
            r.emoji,
            r.user_id,
            COALESCE(NULLIF(sm.nickname, ''), u.display_name) AS display_name
       FROM message_reactions r
       JOIN users u ON u.id = r.user_id
       JOIN messages m ON m.id = r.message_id
       LEFT JOIN channels c ON c.id = m.channel_id
       LEFT JOIN server_members sm
         ON sm.server_id = c.server_id AND sm.user_id = r.user_id
      WHERE r.message_id = ANY($1::uuid[])
      ORDER BY r.created_at ASC`,
    [messageIds],
  );

  return summariseReactionRows(result.rows, viewerId);
}

export async function resolveChannelMemberName(
  channelId: string,
  userId: string,
  fallback: string,
): Promise<string> {
  const result = await getPool().query<{ name: string | null }>(
    `SELECT COALESCE(NULLIF(sm.nickname, ''), $3) AS name
       FROM channels c
       LEFT JOIN server_members sm
         ON sm.server_id = c.server_id AND sm.user_id = $2
      WHERE c.id = $1`,
    [channelId, userId, fallback],
  );
  return result.rows[0]?.name || fallback;
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

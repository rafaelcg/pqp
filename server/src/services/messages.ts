import { formatUserTag, type MessageReaction } from "@pqp/shared";
import { getPool, type DbMessage } from "../db.js";
import { listReactionsForMessages } from "./reactions.js";

export async function listMessages(
  channelId: string,
  limit = 50,
  before?: string,
  viewerId?: string,
): Promise<Array<DbMessage & { reactions: MessageReaction[] }>> {
  const params: unknown[] = [channelId, limit];
  let beforeClause = "";

  if (before) {
    beforeClause = `AND m.created_at < (SELECT created_at FROM messages WHERE id = $3)`;
    params.push(before);
  }

  const result = await getPool().query<DbMessage>(
    `SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at,
            u.display_name as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url
     FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.channel_id = $1 ${beforeClause}
     ORDER BY m.created_at DESC
     LIMIT $2`,
    params,
  );

  const rows = result.rows.reverse();
  const reactionsByMessage = await listReactionsForMessages(
    rows.map((row) => row.id),
    viewerId,
  );

  return rows.map((row) => ({
    ...row,
    reactions: reactionsByMessage.get(row.id) ?? [],
  }));
}

export async function createMessage(
  channelId: string,
  authorId: string,
  body: string,
): Promise<DbMessage & { reactions: MessageReaction[] }> {
  const result = await getPool().query<DbMessage>(
    `INSERT INTO messages (channel_id, author_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, channel_id, author_id, body, created_at`,
    [channelId, authorId, body],
  );
  const message = result.rows[0]!;

  const authorResult = await getPool().query<{
    display_name: string;
    username: string | null;
    discriminator: string | null;
    avatar_url: string | null;
  }>(
    `SELECT display_name, username, discriminator, avatar_url FROM users WHERE id = $1`,
    [authorId],
  );

  const author = authorResult.rows[0];
  return {
    ...message,
    author_name: author?.display_name ?? "User",
    author_username: author?.username ?? null,
    author_discriminator: author?.discriminator ?? null,
    author_avatar_url: author?.avatar_url ?? null,
    reactions: [],
  };
}

export function mapMessage(
  m: DbMessage & { reactions?: MessageReaction[] },
) {
  return {
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author_id,
    authorName: m.author_name ?? "User",
    authorTag: formatUserTag(m.author_username, m.author_discriminator),
    authorAvatarUrl: m.author_avatar_url ?? null,
    body: m.body,
    createdAt: m.created_at.toISOString(),
    reactions: m.reactions ?? [],
  };
}

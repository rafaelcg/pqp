import {
  extractMentionUsernames,
  formatUserTag,
  type MessageReaction,
} from "@pqp/shared";
import { getPool, type DbMessage, type DbUser } from "../db.js";
import { listReactionsForMessages } from "./reactions.js";

export interface MessagePage {
  messages: Array<DbMessage & { reactions: MessageReaction[] }>;
  /** True when older messages exist beyond this page. */
  hasMore: boolean;
}

export class UnknownCursorError extends Error {
  constructor() {
    super("Unknown cursor");
    this.name = "UnknownCursorError";
  }
}

export async function listMessages(
  channelId: string,
  limit = 50,
  before?: string,
  viewerId?: string,
): Promise<MessagePage> {
  const params: unknown[] = [channelId, limit + 1];
  let beforeClause = "";

  if (before) {
    // A cursor row that no longer exists (the message was deleted) makes the
    // row comparison NULL, which silently returns an empty final page. Detect it
    // so the caller can answer 400 instead of pretending history ran out.
    const cursor = await getPool().query(
      `SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2`,
      [before, channelId],
    );
    if (cursor.rows.length === 0) {
      throw new UnknownCursorError();
    }

    // Row comparison rather than created_at alone: two messages can share a
    // timestamp, and a plain `<` would skip or repeat them across pages.
    beforeClause = `AND (m.created_at, m.id) <
      (SELECT created_at, id FROM messages WHERE id = $3)`;
    params.push(before);
  }

  const result = await getPool().query<DbMessage>(
    `SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            u.display_name as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url
     FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.channel_id = $1 ${beforeClause}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $2`,
    params,
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit).reverse();
  const reactionsByMessage = await listReactionsForMessages(
    rows.map((row) => row.id),
    viewerId,
  );

  return {
    hasMore,
    messages: rows.map((row) => ({
      ...row,
      reactions: reactionsByMessage.get(row.id) ?? [],
    })),
  };
}

export async function getMessage(
  messageId: string,
): Promise<(DbMessage & { server_id: string }) | null> {
  const result = await getPool().query<DbMessage & { server_id: string }>(
    `SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            c.server_id,
            u.display_name as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     JOIN users u ON u.id = m.author_id
     WHERE m.id = $1`,
    [messageId],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve `@username` tokens to members of the channel's server and record
 * them, so unread badges can distinguish a mention from ordinary traffic.
 */
async function recordMentions(
  messageId: string,
  channelId: string,
  body: string,
): Promise<void> {
  const usernames = extractMentionUsernames(body);
  if (usernames.length === 0) {
    return;
  }
  await getPool().query(
    `INSERT INTO message_mentions (message_id, user_id)
     SELECT $1, u.id
     FROM users u
     JOIN server_members sm ON sm.user_id = u.id
     JOIN channels c ON c.server_id = sm.server_id
     WHERE c.id = $2 AND u.username = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [messageId, channelId, usernames],
  );
}

export async function createMessage(
  channelId: string,
  author: DbUser,
  body: string,
): Promise<DbMessage & { reactions: MessageReaction[] }> {
  const result = await getPool().query<DbMessage>(
    `INSERT INTO messages (channel_id, author_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, channel_id, author_id, body, created_at, edited_at`,
    [channelId, author.id, body],
  );
  const message = result.rows[0]!;

  await recordMentions(message.id, channelId, body);

  // The author is already in hand from the authenticated session — the previous
  // implementation re-read it from the database on every single message.
  return {
    ...message,
    author_name: author.display_name,
    author_username: author.username,
    author_discriminator: author.discriminator,
    author_avatar_url: author.avatar_url,
    reactions: [],
  };
}

export async function updateMessageBody(
  messageId: string,
  body: string,
): Promise<(DbMessage & { reactions: MessageReaction[] }) | null> {
  const result = await getPool().query<DbMessage>(
    `UPDATE messages m SET body = $2, edited_at = NOW()
     FROM users u
     WHERE m.id = $1 AND u.id = m.author_id
     RETURNING m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
               u.display_name as author_name,
               u.username as author_username,
               u.discriminator as author_discriminator,
               u.avatar_url as author_avatar_url`,
    [messageId, body],
  );
  const message = result.rows[0];
  if (!message) {
    return null;
  }

  await getPool().query(`DELETE FROM message_mentions WHERE message_id = $1`, [
    messageId,
  ]);
  await recordMentions(messageId, message.channel_id, body);

  const reactions = await listReactionsForMessages([messageId]);
  return { ...message, reactions: reactions.get(messageId) ?? [] };
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  const result = await getPool().query(`DELETE FROM messages WHERE id = $1`, [
    messageId,
  ]);
  return (result.rowCount ?? 0) > 0;
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
    editedAt: m.edited_at?.toISOString() ?? null,
    reactions: m.reactions ?? [],
  };
}

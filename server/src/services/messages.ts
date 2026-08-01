import {
  buildReplyExcerpt,
  extractMentionUsernames,
  formatUserTag,
  type MessageReaction,
  type MessageReplyRef,
} from "@pqp/shared";
import { getPool, type DbMessage, type DbUser } from "../db.js";
import { listReactionsForMessages } from "./reactions.js";

/** Parent columns every read path needs to build a quote header. */
const REPLY_COLUMNS = `m.reply_to_id,
            parent.author_id as reply_author_id,
            pu.display_name as reply_author_name,
            parent.body as reply_body`;

const REPLY_JOINS = `LEFT JOIN messages parent ON parent.id = m.reply_to_id
     LEFT JOIN users pu ON pu.id = parent.author_id`;

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
            u.avatar_url as author_avatar_url,
            ${REPLY_COLUMNS}
     FROM messages m
     JOIN users u ON u.id = m.author_id
     ${REPLY_JOINS}
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

/** Just enough of a parent message to validate a reply and quote it. */
export interface ReplyParent {
  id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  body: string;
}

export async function getReplyParent(
  messageId: string,
): Promise<ReplyParent | null> {
  const result = await getPool().query<ReplyParent>(
    `SELECT m.id, m.channel_id, m.author_id, m.body, u.display_name as author_name
     FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.id = $1`,
    [messageId],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve `@username` tokens to members of the channel's server and record
 * them, so unread badges can distinguish a mention from ordinary traffic.
 *
 * A reply counts as a mention of the person being answered — that is the whole
 * difference between a reply that notifies and a reply that decorates — and it
 * lands in the same table, so the unread and badge paths need no change.
 */
async function recordMentions(
  messageId: string,
  channelId: string,
  body: string,
  reply?: { parentId: string; authorId: string },
): Promise<void> {
  const usernames = extractMentionUsernames(body);
  if (usernames.length > 0) {
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

  if (!reply) {
    return;
  }
  // Answering yourself is not a notification. The predicate lives in SQL so a
  // parent deleted between the insert and here simply yields no row.
  await getPool().query(
    `INSERT INTO message_mentions (message_id, user_id)
     SELECT $1, parent.author_id
     FROM messages parent
     WHERE parent.id = $2 AND parent.author_id <> $3
     ON CONFLICT DO NOTHING`,
    [messageId, reply.parentId, reply.authorId],
  );
}

export async function createMessage(
  channelId: string,
  author: DbUser,
  body: string,
  replyToId?: string | null,
): Promise<DbMessage & { reactions: MessageReaction[] }> {
  // One round trip: RETURNING cannot join, so the insert feeds a CTE that the
  // parent lookup hangs off.
  const result = await getPool().query<DbMessage>(
    `WITH inserted AS (
       INSERT INTO messages (channel_id, author_id, body, reply_to_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, channel_id, author_id, body, created_at, edited_at, reply_to_id
     )
     SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            ${REPLY_COLUMNS}
     FROM inserted m
     ${REPLY_JOINS}`,
    [channelId, author.id, body, replyToId ?? null],
  );
  const message = result.rows[0]!;

  await recordMentions(
    message.id,
    channelId,
    body,
    replyToId ? { parentId: replyToId, authorId: author.id } : undefined,
  );

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
    `WITH updated AS (
       UPDATE messages SET body = $2, edited_at = NOW()
       WHERE id = $1
       RETURNING id, channel_id, author_id, body, created_at, edited_at, reply_to_id
     )
     SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            u.display_name as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url,
            ${REPLY_COLUMNS}
     FROM updated m
     JOIN users u ON u.id = m.author_id
     ${REPLY_JOINS}`,
    [messageId, body],
  );
  const message = result.rows[0];
  if (!message) {
    return null;
  }

  await getPool().query(`DELETE FROM message_mentions WHERE message_id = $1`, [
    messageId,
  ]);
  // The reply mention is re-recorded too: an edit wipes the row set, and losing
  // it would quietly downgrade the reply to decoration.
  await recordMentions(
    messageId,
    message.channel_id,
    body,
    message.reply_to_id
      ? { parentId: message.reply_to_id, authorId: message.author_id }
      : undefined,
  );

  const reactions = await listReactionsForMessages([messageId]);
  return { ...message, reactions: reactions.get(messageId) ?? [] };
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  const result = await getPool().query(`DELETE FROM messages WHERE id = $1`, [
    messageId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

function mapReplyTo(m: DbMessage): MessageReplyRef | null {
  if (!m.reply_to_id) {
    return null;
  }
  // `reply_to_id` is nulled when the parent goes, so a set id with no joined row
  // means the delete landed between this query's planning and its joins.
  if (!m.reply_author_id) {
    return {
      id: m.reply_to_id,
      authorId: null,
      authorName: null,
      excerpt: "",
      deleted: true,
    };
  }
  return {
    id: m.reply_to_id,
    authorId: m.reply_author_id,
    authorName: m.reply_author_name ?? "User",
    excerpt: buildReplyExcerpt(m.reply_body ?? ""),
    deleted: false,
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
    editedAt: m.edited_at?.toISOString() ?? null,
    reactions: m.reactions ?? [],
    replyTo: mapReplyTo(m),
  };
}

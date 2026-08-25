import {
  buildReplyExcerpt,
  extractMentions,
  formatUserTag,
  MAX_PINS_PER_CHANNEL,
  type Attachment,
  type Embed,
  type MessagePinnedBy,
  type MessageReaction,
  type MessageReplyRef,
  type ThreadSummary,
  type WebhookEmbed,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool, type DbMessage, type DbUser } from "../db.js";
import { deleteObject } from "../lib/s3.js";
import {
  claimAttachments,
  listAttachmentsForMessages,
  toPublicAttachment,
  verifyPendingAttachments,
} from "./attachments.js";
import { listBlockedAmong, notBlockedSql } from "./blocks.js";
import { listEmbedsForMessages } from "./embeds.js";
import { listReactionsForMessages } from "./reactions.js";
// --- threads ---
import { listThreadsForMessages } from "./threads.js";

/**
 * The pool, or one connection checked out of it. Mention rows carry an FK to
 * the message they belong to, so they have to be written on the same connection
 * as an insert that has not committed yet — from any other, the message does
 * not exist.
 */
type Queryable = Pick<PoolClient, "query">;

/** What every read path hands back: a row plus its batched relations. */
export type HydratedMessage = DbMessage & {
  reactions: MessageReaction[];
  attachments: Attachment[];
  embeds: Embed[];
  /**
   * Whether the viewer of *this* read has blocked the author.
   *
   * Per-viewer, so it is only ever set on a history read, which has one. A live
   * broadcast is encoded once and sent to a whole channel, so there is no
   * single right answer for it and it goes out false — the client collapses
   * live messages from its own block list, which it holds anyway.
   */
  blocked?: boolean;
  // --- threads ---
  /** The thread anchored to this message, batched in by `hydrate` the same
   * way reactions are. Absent (not null) on paths that never carry a chip —
   * a freshly created message cannot have a thread yet. */
  thread?: ThreadSummary | null;
};

/** Parent columns every read path needs to build a quote header. */
const REPLY_COLUMNS = `m.reply_to_id,
            parent.author_id as reply_author_id,
            COALESCE(NULLIF(reply_sm.nickname, ''), pu.display_name) as reply_author_name,
            parent.body as reply_body`;

const REPLY_JOINS = `LEFT JOIN messages parent ON parent.id = m.reply_to_id
     LEFT JOIN users pu ON pu.id = parent.author_id
     LEFT JOIN server_members reply_sm
       ON reply_sm.user_id = parent.author_id
      AND reply_sm.server_id = msg_ch.server_id`;

/** Every history read needs to know who pinned a message, not just when. */
const PIN_COLUMNS = `m.pinned_at, m.pinned_by, pinner.display_name as pinned_by_name`;
const PIN_JOIN = `LEFT JOIN users pinner ON pinner.id = m.pinned_by`;

/** Every history read selects the same shape; only the cursor clause differs. */
const MESSAGE_SELECT = `SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            COALESCE(NULLIF(author_sm.nickname, ''), u.display_name) as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url,
            u.is_webhook as author_is_webhook,
            m.webhook_embeds, m.webhook_username, m.webhook_avatar_url,
            m.mention_everyone, m.mention_here,
            ${REPLY_COLUMNS},
            ${PIN_COLUMNS}
     FROM messages m
     JOIN users u ON u.id = m.author_id
     JOIN channels msg_ch ON msg_ch.id = m.channel_id
     LEFT JOIN server_members author_sm
       ON author_sm.user_id = m.author_id AND author_sm.server_id = msg_ch.server_id
     ${REPLY_JOINS}
     ${PIN_JOIN}`;

export interface MessagePage {
  messages: HydratedMessage[];
  /** True when older messages exist beyond this page. */
  hasMore: boolean;
  /** True when newer messages exist beyond this page — the page is mid-history. */
  hasNewer: boolean;
}

export interface ListMessagesOptions {
  limit?: number;
  /** Page strictly older than this message. */
  before?: string;
  /** Page strictly newer than this message. */
  after?: string;
  /** Centre the page on this message, half of it either side. */
  around?: string;
  viewerId?: string;
}

export class UnknownCursorError extends Error {
  constructor() {
    super("Unknown cursor");
    this.name = "UnknownCursorError";
  }
}

type Direction = "older" | "newer";

interface Cursor {
  id: string;
  direction: Direction;
  /** Whether the cursor row itself belongs to the page. */
  inclusive: boolean;
}

/**
 * A cursor row that no longer exists (the message was deleted) makes the row
 * comparison NULL, which silently returns an empty page. Detect it so the caller
 * can answer 400 instead of pretending history ran out.
 */
async function requireAnchor(
  channelId: string,
  messageId: string,
): Promise<void> {
  const anchor = await getPool().query(
    `SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2`,
    [messageId, channelId],
  );
  if (anchor.rows.length === 0) {
    throw new UnknownCursorError();
  }
}

/**
 * One keyset page, in walk order — descending for `older`, ascending for
 * `newer`. Row comparison rather than created_at alone: two messages can share a
 * timestamp, and a plain `<` would skip or repeat them across pages.
 */
async function keysetPage(
  channelId: string,
  limit: number,
  cursor?: Cursor,
): Promise<{ rows: DbMessage[]; overflow: boolean }> {
  const params: unknown[] = [channelId, limit + 1];
  let cursorClause = "";
  let order = "DESC";

  if (cursor) {
    const operator =
      cursor.direction === "older"
        ? cursor.inclusive
          ? "<="
          : "<"
        : cursor.inclusive
          ? ">="
          : ">";
    cursorClause = `AND (m.created_at, m.id) ${operator}
      (SELECT created_at, id FROM messages WHERE id = $3)`;
    order = cursor.direction === "older" ? "DESC" : "ASC";
    params.push(cursor.id);
  }

  const result = await getPool().query<DbMessage>(
    `${MESSAGE_SELECT}
     WHERE m.channel_id = $1 ${cursorClause}
     ORDER BY m.created_at ${order}, m.id ${order}
     LIMIT $2`,
    params,
  );

  return {
    rows: result.rows.slice(0, limit),
    overflow: result.rows.length > limit,
  };
}

/**
 * Rows are handed over oldest-first, the order the client renders them in.
 *
 * Both relations are fetched for the whole page at once, in parallel. Either one
 * asked per row would turn a fifty-message page into a hundred round trips, and
 * attachments are the more tempting of the two to get wrong because presigning
 * a URL is local work that looks free.
 */
async function hydrate(
  rows: DbMessage[],
  hasMore: boolean,
  hasNewer: boolean,
  viewerId?: string,
): Promise<MessagePage> {
  const messageIds = rows.map((row) => row.id);
  const [
    reactionsByMessage,
    attachmentsByMessage,
    embedsByMessage,
    blockedAuthors,
    // --- threads --- one grouped query per page, same shape as reactions.
    threadsByMessage,
  ] =
    await Promise.all([
      listReactionsForMessages(messageIds, viewerId),
      listAttachmentsForMessages(messageIds),
      // Cache-only — a history read must never trigger a network fetch on
      // someone else's behalf, so a link nobody has posted before yet simply
      // shows no embed until whoever's create/edit request resolves one.
      listEmbedsForMessages(rows),
      // One query for the page, not one per row, and only over the authors
      // actually on it — the viewer's whole block list is unbounded and most of
      // it is irrelevant to any given fifty messages.
      viewerId
        ? listBlockedAmong(viewerId, [
            ...new Set(rows.map((row) => row.author_id)),
          ])
        : Promise.resolve(new Set<string>()),
      listThreadsForMessages(messageIds),
    ]);
  return {
    hasMore,
    hasNewer,
    messages: rows.map((row) => ({
      ...row,
      reactions: reactionsByMessage.get(row.id) ?? [],
      attachments: attachmentsByMessage.get(row.id) ?? [],
      embeds: embedsByMessage.get(row.id) ?? [],
      blocked: blockedAuthors.has(row.author_id),
      thread: threadsByMessage.get(row.id) ?? null,
    })),
  };
}

export async function listMessages(
  channelId: string,
  options: ListMessagesOptions = {},
): Promise<MessagePage> {
  const { limit = 50, before, after, around, viewerId } = options;

  if (around) {
    await requireAnchor(channelId, around);
    // The anchor rides in the older half, so a jump always shows the message it
    // was asked for even when nothing newer exists.
    const olderLimit = Math.ceil(limit / 2);
    const [older, newer] = await Promise.all([
      keysetPage(channelId, olderLimit, {
        id: around,
        direction: "older",
        inclusive: true,
      }),
      keysetPage(channelId, limit - olderLimit, {
        id: around,
        direction: "newer",
        inclusive: false,
      }),
    ]);
    return hydrate(
      [...older.rows.reverse(), ...newer.rows],
      older.overflow,
      newer.overflow,
      viewerId,
    );
  }

  if (after) {
    await requireAnchor(channelId, after);
    const page = await keysetPage(channelId, limit, {
      id: after,
      direction: "newer",
      inclusive: false,
    });
    // The cursor and everything behind it are older than this page by
    // definition, so history is always still there to walk back into.
    return hydrate(page.rows, true, page.overflow, viewerId);
  }

  if (before) {
    await requireAnchor(channelId, before);
    const page = await keysetPage(channelId, limit, {
      id: before,
      direction: "older",
      inclusive: false,
    });
    return hydrate(page.rows.reverse(), page.overflow, true, viewerId);
  }

  const page = await keysetPage(channelId, limit);
  return hydrate(page.rows.reverse(), page.overflow, false, viewerId);
}

/**
 * `server_id` is null when the message is in a conversation, and callers must
 * branch on it rather than pass it on: a conversation has no moderators, so a
 * check that would have asked "can this user manage the server" has no server
 * to ask about and must not fall through to an answer.
 */
export async function getMessage(
  messageId: string,
): Promise<
  (DbMessage & { server_id: string | null; attachments: Attachment[] }) | null
> {
  const result = await getPool().query<DbMessage & { server_id: string | null }>(
    `SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            c.server_id,
            u.display_name as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url,
            ${PIN_COLUMNS}
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     JOIN users u ON u.id = m.author_id
     ${PIN_JOIN}
     WHERE m.id = $1`,
    [messageId],
  );
  const message = result.rows[0];
  if (!message) {
    return null;
  }
  // Carried because the edit route has to know whether this message says
  // anything other than its attachments before it decides an empty body is
  // legal.
  const attachments = await listAttachmentsForMessages([messageId]);
  return { ...message, attachments: attachments.get(messageId) ?? [] };
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
 * Resolve `@username` tokens to people who can be mentioned here and record
 * them, so unread badges can distinguish a mention from ordinary traffic.
 *
 * Who that is depends on the kind of channel, and the old query could not ask:
 * it reached the mentionable set through `JOIN channels c ON c.server_id =
 * sm.server_id`, which for a conversation joins on a NULL server and matches
 * nobody — every mention in a DM would silently record no rows at all. The
 * `CASE` below is the same split as `channelVisibleSql`: a server channel
 * mentions the server's members, a conversation mentions its participants.
 *
 * Somebody who has blocked the author is never mentioned, in either kind. A
 * mention is the loudest notification the product has, so leaving this out
 * would make an @ the way around a block.
 *
 * A reply counts as a mention of the person being answered — that is the whole
 * difference between a reply that notifies and a reply that decorates — and it
 * lands in the same table, so the unread and badge paths need no change.
 */
export interface MentionWrite {
  extraUserIds?: readonly string[];
  mentionEveryone?: boolean;
  mentionHere?: boolean;
  canMentionEveryone?: boolean;
}

async function recordMentions(
  db: Queryable,
  messageId: string,
  channelId: string,
  authorId: string,
  body: string,
  reply?: { parentId: string; authorId: string },
  extra?: MentionWrite,
): Promise<void> {
  const parsed = extractMentions(body);
  const usernames = parsed.usernames;
  if (usernames.length > 0) {
    await db.query(
      `INSERT INTO message_mentions (message_id, user_id)
       SELECT $1::uuid, u.id
       FROM users u
       CROSS JOIN channels c
       WHERE c.id = $2
         AND u.username = ANY($3::text[])
         AND CASE WHEN c.kind = 'server' THEN
               EXISTS (
                 SELECT 1 FROM server_members sm
                 WHERE sm.server_id = c.server_id AND sm.user_id = u.id
               )
             ELSE
               EXISTS (
                 SELECT 1 FROM channel_members cm
                 WHERE cm.channel_id = c.id AND cm.user_id = u.id
               )
             END
         AND ${notBlockedSql("u.id", "$4")}
       ON CONFLICT DO NOTHING`,
      [messageId, channelId, usernames, authorId],
    );
  }

  if (parsed.roleNames.length > 0) {
    await db.query(
      `INSERT INTO message_mentions (message_id, user_id)
       SELECT DISTINCT $1::uuid, mr.user_id
       FROM channels c
       JOIN roles r ON r.server_id = c.server_id
       JOIN member_roles mr ON mr.role_id = r.id AND mr.server_id = c.server_id
       WHERE c.id = $2
         AND c.kind = 'server'
         AND LOWER(r.name) = ANY($3::text[])
         AND (r.mentionable OR $5::boolean)
         AND mr.user_id <> $4
         AND NOT EXISTS (
           SELECT 1 FROM users named
            WHERE named.username = LOWER(r.name)
              AND CASE WHEN c.kind = 'server' THEN
                    EXISTS (
                      SELECT 1 FROM server_members sm
                       WHERE sm.server_id = c.server_id AND sm.user_id = named.id
                    )
                  ELSE
                    EXISTS (
                      SELECT 1 FROM channel_members cm
                       WHERE cm.channel_id = c.id AND cm.user_id = named.id
                    )
                  END
         )
         AND ${notBlockedSql("mr.user_id", "$4")}
       ON CONFLICT DO NOTHING`,
      [
        messageId,
        channelId,
        parsed.roleNames,
        authorId,
        extra?.mentionEveryone === true || extra?.canMentionEveryone === true,
      ],
    );
  }

  const extraIds = extra?.extraUserIds ?? [];
  if (extraIds.length > 0) {
    await db.query(
      `INSERT INTO message_mentions (message_id, user_id)
       SELECT $1::uuid, x.user_id
       FROM UNNEST($2::uuid[]) AS x(user_id)
       WHERE x.user_id <> $3
         AND ${notBlockedSql("x.user_id", "$3")}
       ON CONFLICT DO NOTHING`,
      [messageId, extraIds, authorId],
    );
  }

  if (!reply) {
    return;
  }
  await db.query(
    `INSERT INTO message_mentions (message_id, user_id)
     SELECT $1::uuid, parent.author_id
     FROM messages parent
     WHERE parent.id = $2 AND parent.author_id <> $3
       AND ${notBlockedSql("parent.author_id", "$3")}
     ON CONFLICT DO NOTHING`,
    [messageId, reply.parentId, reply.authorId],
  );
}

/**
 * Insert a message and pull its attachments onto it, atomically.
 *
 * Verification runs first, on the pool, before any transaction is open, because
 * confirming an upload costs one HTTP HEAD per attachment with a ten second
 * timeout. Inside the transaction those HEADs park a pooled connection
 * idle-in-transaction for the whole timeout whenever the bucket blackholes
 * packets instead of refusing fast, and a handful of concurrent image sends
 * then drain the pool — every unrelated query in the process, down to the
 * membership check on each inbound WS frame, queues behind a storage outage.
 * Nothing between BEGIN and COMMIT below may touch the network.
 *
 * The insert, the claim and the mentions still share one transaction, because
 * claiming is where an attachment's ownership is actually enforced: split
 * across two, a message could be broadcast carrying rows a concurrent send had
 * already taken, or survive a claim that failed. That the verifying SELECT ran
 * on another connection costs nothing — `claimAttachments` re-states ownership
 * in its own UPDATE, under the row lock.
 *
 * Returns null when the frame turns out to say nothing at all: `body` was empty
 * and every attachment failed verification. The shared schema already refuses
 * `{body: "", attachmentIds: []}`, but it cannot know which uploads exist, so
 * this is the same rule re-checked once the answer is in — and the insert is
 * rolled back rather than leaving a blank message in the channel.
 */
export async function createMessage(
  channelId: string,
  author: DbUser,
  body: string,
  replyToId?: string | null,
  attachmentIds?: string[],
  mentions?: MentionWrite,
): Promise<HydratedMessage | null> {
  const verified = attachmentIds?.length
    ? await verifyPendingAttachments(channelId, author.id, attachmentIds)
    : [];

  const nickRow = await getPool().query<{ nickname: string | null }>(
    `SELECT sm.nickname
       FROM channels c
       LEFT JOIN server_members sm
         ON sm.server_id = c.server_id AND sm.user_id = $2
      WHERE c.id = $1`,
    [channelId, author.id],
  );
  const authorName = nickRow.rows[0]?.nickname || author.display_name;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // One round trip: RETURNING cannot join, so the insert feeds a CTE that the
    // parent lookup hangs off.
    const result = await client.query<DbMessage>(
      `WITH inserted AS (
         INSERT INTO messages (channel_id, author_id, body, reply_to_id, mention_everyone, mention_here)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, channel_id, author_id, body, created_at, edited_at, reply_to_id,
                   mention_everyone, mention_here
       )
       SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
              m.mention_everyone, m.mention_here,
              ${REPLY_COLUMNS}
       FROM inserted m
       JOIN channels msg_ch ON msg_ch.id = m.channel_id
       ${REPLY_JOINS}`,
      [
        channelId,
        author.id,
        body,
        replyToId ?? null,
        mentions?.mentionEveryone === true,
        mentions?.mentionHere === true,
      ],
    );
    // A message is never born pinned, so the columns above are left out rather
    // than joined for nothing — mapMessage already treats them as optional.
    const message = result.rows[0]!;

    const claimed = await claimAttachments(client, message.id, verified);

    if (body.length === 0 && claimed.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await recordMentions(
      client,
      message.id,
      channelId,
      author.id,
      body,
      replyToId ? { parentId: replyToId, authorId: author.id } : undefined,
      mentions,
    );

    await client.query("COMMIT");

    return {
      ...message,
      author_name: authorName,
      author_username: author.username,
      author_discriminator: author.discriminator,
      author_avatar_url: author.avatar_url,
      reactions: [],
      attachments: claimed.map(toPublicAttachment),
      // A message is never born with an embed — whether the body contains an
      // unfurlable link is resolved after the fact by the caller, same as the
      // background fetch that follows a fresh create over the WS.
      embeds: [],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateMessageBody(
  messageId: string,
  body: string,
): Promise<HydratedMessage | null> {
  const result = await getPool().query<DbMessage>(
    `WITH updated AS (
       UPDATE messages SET body = $2, edited_at = NOW()
       WHERE id = $1
       RETURNING id, channel_id, author_id, body, created_at, edited_at, reply_to_id,
                 pinned_at, pinned_by
     )
     SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            COALESCE(NULLIF(author_sm.nickname, ''), u.display_name) as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url,
            ${REPLY_COLUMNS},
            ${PIN_COLUMNS}
     FROM updated m
     JOIN users u ON u.id = m.author_id
     JOIN channels msg_ch ON msg_ch.id = m.channel_id
     LEFT JOIN server_members author_sm
       ON author_sm.user_id = m.author_id AND author_sm.server_id = msg_ch.server_id
     ${REPLY_JOINS}
     ${PIN_JOIN}`,
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
    getPool(),
    messageId,
    message.channel_id,
    message.author_id,
    body,
    message.reply_to_id
      ? { parentId: message.reply_to_id, authorId: message.author_id }
      : undefined,
  );

  // An edit never touches attachments, but the broadcast it produces is a whole
  // message — dropping them here would blank the images out of every open tab
  // until the next history load. Embeds are cache-only here, same as every
  // other read: whether an edited-in link needs a fresh fetch is the caller's
  // decision, not this function's. The thread chip rides along for the same
  // reason the attachments do: the broadcast is a whole message, and a chip
  // that vanished on every edit would read as the thread being deleted.
  const [reactions, attachments, embeds, threads] = await Promise.all([
    listReactionsForMessages([messageId]),
    listAttachmentsForMessages([messageId]),
    listEmbedsForMessages([message]),
    listThreadsForMessages([messageId]),
  ]);
  return {
    ...message,
    reactions: reactions.get(messageId) ?? [],
    attachments: attachments.get(messageId) ?? [],
    embeds: embeds.get(messageId) ?? [],
    thread: threads.get(messageId) ?? null,
  };
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  // Read before the delete, because `message_attachments.message_id` is
  // ON DELETE SET NULL: once the message is gone the rows are still there but
  // nothing links them back to it.
  const attached = await getPool().query<{ storage_key: string }>(
    `SELECT storage_key FROM message_attachments WHERE message_id = $1`,
    [messageId],
  );

  const result = await getPool().query(`DELETE FROM messages WHERE id = $1`, [
    messageId,
  ]);
  const deleted = (result.rowCount ?? 0) > 0;

  if (deleted && attached.rows.length > 0) {
    // Deliberately not awaited and deliberately allowed to fail. The sweeper
    // collects every orphan an hour later and this changes nothing about
    // whether the bytes eventually go — it only makes them go sooner, for the
    // common case of someone deleting a 10 MiB video they just posted. Turning
    // it into a blocking step would put a bucket round trip per attachment in
    // front of a response that is otherwise two queries, and would let a
    // storage outage fail a delete that has already happened.
    void Promise.all(
      attached.rows.map((row) =>
        deleteObject(row.storage_key).catch((error: unknown) => {
          console.error(
            `[attachments] deferred delete of ${row.storage_key} to the sweeper:`,
            error instanceof Error ? error.message : error,
          );
        }),
      ),
    );
  }

  return deleted;
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

/**
 * Stays synchronous even though every attachment carries a freshly presigned
 * URL: signing is an HMAC over strings with no network call, so the cost is the
 * same whether it happens here or a layer up. The batched *fetch* is the async
 * part, and it has already happened by the time a row reaches this.
 */
/**
 * Absent unless `pinned_at` is set — a set `pinned_by` with no display name
 * means the pinner's account is gone (`ON DELETE SET NULL` clears the column
 * itself, so this only fires in the gap between that and a row already read).
 */
function mapPinnedBy(m: DbMessage): MessagePinnedBy | null {
  if (!m.pinned_at || !m.pinned_by) {
    return null;
  }
  return { id: m.pinned_by, displayName: m.pinned_by_name ?? "User" };
}

export function mapMessage(
  m: DbMessage & {
    reactions?: MessageReaction[];
    attachments?: Attachment[];
    embeds?: Embed[];
    blocked?: boolean;
    thread?: ThreadSummary | null;
  },
) {
  return {
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author_id,
    // A per-execution override (Discord's own webhooks allow one) wins over
    // the webhook's own configured name/avatar, which in turn is already
    // what `author_name`/`author_avatar_url` hold for a webhook's pseudo-user.
    authorName: m.webhook_username ?? m.author_name ?? "User",
    authorTag: formatUserTag(m.author_username, m.author_discriminator),
    authorAvatarUrl: m.webhook_avatar_url ?? m.author_avatar_url ?? null,
    body: m.body,
    createdAt: m.created_at.toISOString(),
    editedAt: m.edited_at?.toISOString() ?? null,
    reactions: m.reactions ?? [],
    replyTo: mapReplyTo(m),
    attachments: m.attachments ?? [],
    embeds: m.embeds ?? [],
    // Sent rather than filtered. Dropping the row instead would corrupt
    // `listMessages`: it pages by keyset and reports `hasMore` from how many
    // rows the query read, so a page silently short of its limit reads as
    // "history ran out" in the middle of a conversation. The body travels and
    // the client draws the curtain.
    blocked: m.blocked ?? false,
    pinnedAt: m.pinned_at?.toISOString() ?? null,
    pinnedBy: mapPinnedBy(m),
    isWebhook: m.author_is_webhook ?? false,
    mentionEveryone: m.mention_everyone ?? false,
    mentionHere: m.mention_here ?? false,
    webhookEmbeds: (m.webhook_embeds as WebhookEmbed[] | null) ?? [],
    // --- threads ---
    thread: m.thread ?? null,
  };
}

export class ChannelPinLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`This channel already has ${limit} pinned messages`);
    this.name = "ChannelPinLimitError";
  }
}

async function hydrateOne(
  message: DbMessage,
): Promise<HydratedMessage> {
  const [reactions, attachments, embeds, threads] = await Promise.all([
    listReactionsForMessages([message.id]),
    listAttachmentsForMessages([message.id]),
    listEmbedsForMessages([message]),
    // --- threads --- pin/unpin broadcasts are whole messages too.
    listThreadsForMessages([message.id]),
  ]);
  return {
    ...message,
    reactions: reactions.get(message.id) ?? [],
    attachments: attachments.get(message.id) ?? [],
    embeds: embeds.get(message.id) ?? [],
    thread: threads.get(message.id) ?? null,
  };
}

/**
 * Pin a message, or hand back its current state if it already is one.
 *
 * Idempotent by design rather than by accident: `COALESCE` on both columns
 * means a second pin from a second admin does not reset who gets credit for
 * it or bump the sort order in the panel. The cap is checked only on the path
 * that would actually add a new pin — re-pinning an already-pinned message
 * must never be blocked by a channel that happens to be at the ceiling.
 *
 * The count-then-update is two statements, not one transaction with a row
 * lock: `MAX_PINS_PER_CHANNEL` is a soft UX ceiling, not a security boundary,
 * so a race that lets two concurrent pins land at 51 instead of 50 is an
 * accepted, harmless overshoot rather than something worth serializing every
 * pin in a channel to prevent.
 */
export async function pinMessage(
  messageId: string,
  pinnedBy: string,
): Promise<HydratedMessage | null> {
  const existing = await getPool().query<{
    channel_id: string;
    pinned_at: Date | null;
  }>(`SELECT channel_id, pinned_at FROM messages WHERE id = $1`, [messageId]);
  const row = existing.rows[0];
  if (!row) {
    return null;
  }

  if (!row.pinned_at) {
    const count = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages
       WHERE channel_id = $1 AND pinned_at IS NOT NULL`,
      [row.channel_id],
    );
    if (Number(count.rows[0]!.count) >= MAX_PINS_PER_CHANNEL) {
      throw new ChannelPinLimitError(MAX_PINS_PER_CHANNEL);
    }
  }

  const result = await getPool().query<DbMessage>(
    `WITH updated AS (
       UPDATE messages
       SET pinned_at = COALESCE(pinned_at, NOW()),
           pinned_by = COALESCE(pinned_by, $2)
       WHERE id = $1
       RETURNING id, channel_id, author_id, body, created_at, edited_at, reply_to_id,
                 pinned_at, pinned_by
     )
     SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            COALESCE(NULLIF(author_sm.nickname, ''), u.display_name) as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url,
            ${REPLY_COLUMNS},
            ${PIN_COLUMNS}
     FROM updated m
     JOIN users u ON u.id = m.author_id
     JOIN channels msg_ch ON msg_ch.id = m.channel_id
     LEFT JOIN server_members author_sm
       ON author_sm.user_id = m.author_id AND author_sm.server_id = msg_ch.server_id
     ${REPLY_JOINS}
     ${PIN_JOIN}`,
    [messageId, pinnedBy],
  );
  return hydrateOne(result.rows[0]!);
}

/** Unpinning an already-unpinned message is a no-op success, not an error —
 * the client never has to check "was this actually pinned" before offering
 * the button. */
export async function unpinMessage(
  messageId: string,
): Promise<HydratedMessage | null> {
  const result = await getPool().query<DbMessage>(
    `WITH updated AS (
       UPDATE messages SET pinned_at = NULL, pinned_by = NULL
       WHERE id = $1
       RETURNING id, channel_id, author_id, body, created_at, edited_at, reply_to_id,
                 pinned_at, pinned_by
     )
     SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at, m.edited_at,
            COALESCE(NULLIF(author_sm.nickname, ''), u.display_name) as author_name,
            u.username as author_username,
            u.discriminator as author_discriminator,
            u.avatar_url as author_avatar_url,
            ${REPLY_COLUMNS},
            ${PIN_COLUMNS}
     FROM updated m
     JOIN users u ON u.id = m.author_id
     JOIN channels msg_ch ON msg_ch.id = m.channel_id
     LEFT JOIN server_members author_sm
       ON author_sm.user_id = m.author_id AND author_sm.server_id = msg_ch.server_id
     ${REPLY_JOINS}
     ${PIN_JOIN}`,
    [messageId],
  );
  const message = result.rows[0];
  return message ? hydrateOne(message) : null;
}

/**
 * Every pin in a channel, newest first. No pagination: the cap keeps this to
 * at most `MAX_PINS_PER_CHANNEL` rows, which is one page by construction.
 */
export async function listPinnedMessages(
  channelId: string,
): Promise<HydratedMessage[]> {
  const result = await getPool().query<DbMessage>(
    `${MESSAGE_SELECT}
     WHERE m.channel_id = $1 AND m.pinned_at IS NOT NULL
     ORDER BY m.pinned_at DESC`,
    [channelId],
  );
  const messageIds = result.rows.map((row) => row.id);
  const [reactionsByMessage, attachmentsByMessage, embedsByMessage] = await Promise.all([
    listReactionsForMessages(messageIds),
    listAttachmentsForMessages(messageIds),
    listEmbedsForMessages(result.rows),
  ]);
  return result.rows.map((row) => ({
    ...row,
    reactions: reactionsByMessage.get(row.id) ?? [],
    attachments: attachmentsByMessage.get(row.id) ?? [],
    embeds: embedsByMessage.get(row.id) ?? [],
  }));
}

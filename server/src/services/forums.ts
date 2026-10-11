import {
  FORUM_ANSWER_EXCERPT_MAX,
  FORUM_ERRORS,
  FORUM_MAX_PINNED,
  FORUM_PAGE_SIZE,
  FORUM_PREVIEW_MAX,
  FORUM_SETTINGS_DEFAULTS,
  FORUM_SHELL_TTL_MS,
  FORUM_SIMILAR_MAX,
  FORUM_UNREAD_CAP,
  type ForumAcceptedAnswer,
  type ForumPostListResponse,
  type ForumPostSummary,
  type ForumPostViewer,
  type ForumSettings,
  type ForumSort,
  type ForumTag,
  type ListForumPostsQuery,
  type PutForumTagsRequest,
  type UpdateForumSettingsRequest,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { coalesce, invalidate } from "../lib/read-cache.js";
import { listAttachmentsForMessages } from "./attachments.js";
import { deleteChannel } from "./servers.js";

/**
 * Forum channels, the database half: everything that reads or writes the
 * forum side tables (`schema.sql`, "forum channels") and nothing that talks
 * to a socket. The wire contract and every rule implemented here are in
 * `packages/shared/src/forums.ts`; read its header first.
 *
 * WHY TWO MODULES. Creating a post ends in `postChannelMessage` (the opening
 * message takes the path every message takes) and every write ends in a
 * `forum-post-upsert` frame, both of which live in `ws/chat.ts`. And the send
 * path in `ws/chat.ts` bumps a post on every reply, which reads from here. So
 * this file imports nothing from `ws/`, the orchestration that needs both is
 * `services/forum-posts.ts`, and the import graph has no cycle.
 *
 * ACCESS IS NOT CHECKED HERE. The routes check the caller can see the forum
 * (`requireChannelAccess`, which answers for a post with its parent's answer)
 * and the permission bits; these functions trust their arguments, like
 * `services/threads.ts`.
 */

// ---------------------------------------------------------------- errors

/**
 * A refusal with the house `{ error }` token and, for the 422 a create
 * answers, the `message-rejected` fields beside it. The route layer turns it
 * into the HTTP answer; nothing here knows about HTTP.
 */
export class ForumError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ForumError";
  }
}

// ----------------------------------------------------------------- cache

/**
 * The read cache's key family for one forum's first pages. Shared between
 * viewers on purpose (the shared half of the list holds nothing about who is
 * asking, see `forumPostSummarySchema`); per process, so a sibling may serve
 * a page up to one TTL old, which the live `forum-post-upsert` frame closes.
 */
function listCachePrefix(forumId: string): string {
  return `forum:posts:${forumId}:`;
}

/** Every write that changes what a list shows calls this. This process only. */
export function invalidateForumList(forumId: string): void {
  invalidate(listCachePrefix(forumId));
}

// ------------------------------------------------------------ unaccent

/**
 * `unaccent` is installed best effort (`schema.sql`: a host that refuses it
 * boots anyway), so calling the FUNCTION blindly would turn every title
 * search into a 500 on such a host. Asked once per process; the answer only
 * changes with a schema run, and a process that started before one is
 * restarted by it.
 */
let unaccentProbe: Promise<boolean> | null = null;

export function hasUnaccent(): Promise<boolean> {
  unaccentProbe ??= getPool()
    .query<{ ok: boolean }>(
      `SELECT to_regprocedure('unaccent(text)') IS NOT NULL AS ok`,
    )
    .then((result) => result.rows[0]?.ok === true)
    .catch((error: unknown) => {
      // Not cached: the next search asks again.
      unaccentProbe = null;
      throw error;
    });
  return unaccentProbe;
}

/**
 * Test seam: forget the probe, or pin its answer (`false` is a host without
 * the extension, which a shared test database cannot be made into, since the
 * search configurations depend on it).
 */
export function resetUnaccentProbeForTests(pinned?: boolean): void {
  unaccentProbe = pinned === undefined ? null : Promise.resolve(pinned);
}

/** The SQL that folds a text column (or parameter) for title matching. */
function foldSql(expression: string, unaccent: boolean): string {
  return unaccent ? `unaccent(lower(${expression}))` : `lower(${expression})`;
}

/** LIKE's own metacharacters, escaped, so `100%` searches for "100%". */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// ------------------------------------------------------------- summaries

interface SummaryRow {
  channel_id: string;
  forum_id: string;
  title: string;
  author_id: string | null;
  created_at: Date;
  last_activity_at: Date;
  pinned_at: Date | null;
  locked_at: Date | null;
  resolved_at: Date | null;
  resolved_message_id: string | null;
  om_id: string | null;
  om_body: string | null;
  webhook_username: string | null;
  webhook_avatar_url: string | null;
  author_display_name: string | null;
  author_avatar_url: string | null;
  author_is_webhook: boolean | null;
  attachment_count: number;
  opening_is_voice: boolean;
  reply_count: number;
  reaction_count: number;
  top_reaction: { emoji: string; count: number } | null;
  tag_ids: string[];
}

/**
 * The shared half of a post, for a set of ids, in no particular order. One
 * statement; the counts are correlated subqueries bounded by one post each
 * (`idx_messages_channel_created`, the reactions and attachments indexes),
 * the same "computed on read" trade the plan measured for a page of 50.
 */
const SUMMARY_SQL = `
  SELECT p.channel_id, p.forum_id, c.name AS title, p.author_id,
         p.created_at, p.last_activity_at, p.pinned_at, p.locked_at,
         p.resolved_at, p.resolved_message_id,
         om.id AS om_id, om.body AS om_body,
         om.webhook_username, om.webhook_avatar_url,
         COALESCE(NULLIF(sm.nickname, ''), u.display_name) AS author_display_name,
         u.avatar_url AS author_avatar_url,
         u.is_webhook AS author_is_webhook,
         (SELECT count(*) FROM message_attachments a
           WHERE a.message_id = om.id)::int AS attachment_count,
         EXISTS (SELECT 1 FROM message_attachments a
                   JOIN message_attachment_voice v ON v.attachment_id = a.id
                  WHERE a.message_id = om.id) AS opening_is_voice,
         (SELECT count(*) FROM messages m
           WHERE m.channel_id = p.channel_id
             AND m.id IS DISTINCT FROM p.opening_message_id)::int AS reply_count,
         (SELECT count(*) FROM message_reactions r
           WHERE r.message_id = om.id)::int AS reaction_count,
         (SELECT jsonb_build_object('emoji', r.emoji, 'count', count(*))
            FROM message_reactions r
           WHERE r.message_id = om.id
           GROUP BY r.emoji
           ORDER BY count(*) DESC, min(r.created_at) ASC
           LIMIT 1) AS top_reaction,
         ARRAY(SELECT pt.tag_id
                 FROM forum_post_tags pt
                 JOIN forum_tags t ON t.id = pt.tag_id
                WHERE pt.post_id = p.channel_id
                ORDER BY t.position, t.created_at, t.id) AS tag_ids
    FROM forum_posts p
    JOIN channels c ON c.id = p.channel_id
    LEFT JOIN messages om ON om.id = p.opening_message_id
    LEFT JOIN users u ON u.id = p.author_id
    LEFT JOIN server_members sm
      ON sm.user_id = p.author_id AND sm.server_id = c.server_id
   WHERE p.channel_id = ANY($1::uuid[])
     AND p.published_at IS NOT NULL`;

/** First `max` characters, whitespace flattened; null when nothing is left. */
function flatten(body: string | null, max: number): string | null {
  if (body === null) {
    return null;
  }
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length === 0) {
    return null;
  }
  // By code point, so an emoji at the cut is never split in half.
  const points = Array.from(flat);
  return points.length > max ? points.slice(0, max).join("") : flat;
}

function toSummary(row: SummaryRow): Omit<
  ForumPostSummary,
  "thumbnailUrl" | "thumbnailAttachmentId" | "thumbnailWidth" | "thumbnailHeight"
> {
  const openingDeleted = row.om_id === null;
  const preview = openingDeleted ? null : flatten(row.om_body, FORUM_PREVIEW_MAX);
  const openingKind = openingDeleted
    ? null
    : row.opening_is_voice
      ? "voice"
      : preview === null && row.attachment_count > 0
        ? "attachment"
        : "text";
  const authorGone = row.author_id === null;
  return {
    id: row.channel_id,
    forumId: row.forum_id,
    title: row.title,
    authorId: row.author_id,
    // A feed names each item through the per-message override, the way the
    // message row itself does (`mapMessage`).
    authorName: authorGone
      ? null
      : (row.webhook_username ?? row.author_display_name ?? null),
    authorAvatarUrl: authorGone
      ? null
      : (row.webhook_avatar_url ?? row.author_avatar_url ?? null),
    authorIsWebhook: row.author_is_webhook === true,
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    lockedAt: row.locked_at?.toISOString() ?? null,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    acceptedAnswerId: row.resolved_message_id,
    preview,
    openingDeleted,
    openingKind,
    attachmentCount: row.attachment_count,
    replyCount: row.reply_count,
    reactionCount: row.reaction_count,
    topReaction:
      row.top_reaction && row.top_reaction.count > 0
        ? { emoji: row.top_reaction.emoji, count: Number(row.top_reaction.count) }
        : null,
    tagIds: row.tag_ids,
  };
}

/**
 * Summaries for these post ids, in the order given; ids that are not
 * published posts are dropped. The thumbnail is the opening message's first
 * image, signed exactly as the message row would sign it
 * (`listAttachmentsForMessages`), so a card and the message agree.
 */
export async function readForumPostSummaries(
  postIds: readonly string[],
): Promise<ForumPostSummary[]> {
  if (postIds.length === 0) {
    return [];
  }
  const result = await getPool().query<SummaryRow>(SUMMARY_SQL, [postIds]);
  const byId = new Map(result.rows.map((row) => [row.channel_id, row]));

  const withFiles = result.rows
    .filter((row) => row.om_id !== null && row.attachment_count > 0)
    .map((row) => row.om_id!);
  const attachments =
    withFiles.length > 0
      ? await listAttachmentsForMessages(withFiles)
      : new Map<string, never[]>();

  const out: ForumPostSummary[] = [];
  for (const id of postIds) {
    const row = byId.get(id);
    if (!row) {
      continue;
    }
    const image = row.om_id
      ? (attachments.get(row.om_id) ?? []).find(
          (file) => file.contentType.startsWith("image/") && !file.voice,
        )
      : undefined;
    out.push({
      ...toSummary(row),
      thumbnailUrl: image?.url ?? null,
      thumbnailAttachmentId: image?.id ?? null,
      thumbnailWidth: image?.width ?? null,
      thumbnailHeight: image?.height ?? null,
    });
  }
  return out;
}

export async function getForumPostSummary(
  postId: string,
): Promise<ForumPostSummary | null> {
  return (await readForumPostSummaries([postId]))[0] ?? null;
}

// --------------------------------------------------------------- viewer

/**
 * The per-viewer half for a page of posts. Never cached, never framed. The
 * new-reply count stops reading at the cap, so a 20,000-reply post costs the
 * same as one with 99.
 */
export async function readForumPostViewers(
  postIds: readonly string[],
  viewerId: string,
): Promise<ForumPostViewer[]> {
  if (postIds.length === 0) {
    return [];
  }
  const result = await getPool().query<{
    post_id: string;
    last_read_at: Date | null;
    new_reply_count: number;
    following: boolean;
  }>(
    `SELECT ids.post_id, cr.last_read_at,
            CASE WHEN cr.last_read_at IS NULL THEN 0 ELSE (
              SELECT count(*) FROM (
                SELECT 1 FROM messages m
                 WHERE m.channel_id = ids.post_id
                   AND m.created_at > cr.last_read_at
                   AND m.author_id <> $2
                 LIMIT ${FORUM_UNREAD_CAP}
              ) capped
            ) END::int AS new_reply_count,
            COALESCE(NOT f.muted, FALSE) AS following
       FROM unnest($1::uuid[]) AS ids(post_id)
       LEFT JOIN channel_reads cr
         ON cr.channel_id = ids.post_id AND cr.user_id = $2
       LEFT JOIN forum_post_follows f
         ON f.post_id = ids.post_id AND f.user_id = $2`,
    [postIds, viewerId],
  );
  const byId = new Map(result.rows.map((row) => [row.post_id, row]));
  return postIds.map((postId) => {
    const row = byId.get(postId);
    return {
      postId,
      lastReadAt: row?.last_read_at?.toISOString() ?? null,
      newReplyCount: row?.new_reply_count ?? 0,
      following: row?.following ?? false,
    };
  });
}

// ----------------------------------------------------------------- list

interface ListCursor {
  sort: ForumSort;
  /** The sort key with microseconds, UTC. Millisecond JS dates would skip rows. */
  at: string;
  id: string;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([cursor.sort, cursor.at, cursor.id])).toString(
    "base64url",
  );
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(raw: string, sort: ForumSort): ListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === sort &&
      typeof parsed[1] === "string" &&
      CURSOR_AT.test(parsed[1]) &&
      typeof parsed[2] === "string" &&
      UUID.test(parsed[2])
    ) {
      return { sort, at: parsed[1], id: parsed[2] };
    }
  } catch {
    // Falls through to the refusal.
  }
  // A cursor from the other sort (the client switched order and kept its
  // cursor) is as wrong as garbage: it names a position in a different list.
  throw new ForumError(400, "Invalid cursor");
}

const KEY_TEXT = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ListForumPostsInput {
  forumId: string;
  viewerId: string;
  query: ListForumPostsQuery;
}

type SharedPage = Omit<ForumPostListResponse, "viewer" | "forumPreviousReadAt">;

/**
 * One page of a forum. The shared half (`pinned`, `posts`, `nextCursor`,
 * `counts`) is the same for every viewer who can see the forum, so page 1
 * without `mine` or `q` goes through the read cache; everything after it, and
 * every search, reads Postgres. The per-viewer half is read for the page's
 * ids every time.
 */
export async function listForumPosts(
  input: ListForumPostsInput,
): Promise<ForumPostListResponse> {
  const { forumId, viewerId, query } = input;
  const sort = query.sort ?? (await getForumSettings(forumId)).defaultSort;
  const limit = query.limit ?? FORUM_PAGE_SIZE;
  const cursor = query.cursor ? decodeCursor(query.cursor, sort) : null;
  const tags = query.tag ? [...query.tag].sort() : [];

  const load = () =>
    readSharedPage({
      forumId,
      sort,
      limit,
      cursor,
      tags,
      status: query.status ?? null,
      authorId: query.mine ? viewerId : null,
      q: query.q ?? null,
    });

  const cacheable = !cursor && !query.mine && !query.q;
  const shared = cacheable
    ? await coalesce(
        `${listCachePrefix(forumId)}${sort}:${limit}:${query.status ?? "-"}:${tags.join(",")}`,
        undefined,
        load,
      )
    : await load();

  const ids = [...shared.pinned, ...shared.posts].map((post) => post.id);
  const [viewer, forumRead] = await Promise.all([
    readForumPostViewers(ids, viewerId),
    getPool().query<{ last_read_at: Date }>(
      `SELECT last_read_at FROM channel_reads WHERE channel_id = $1 AND user_id = $2`,
      [forumId, viewerId],
    ),
  ]);
  return {
    ...shared,
    viewer,
    forumPreviousReadAt: forumRead.rows[0]?.last_read_at.toISOString() ?? null,
  };
}

async function readSharedPage(args: {
  forumId: string;
  sort: ForumSort;
  limit: number;
  cursor: ListCursor | null;
  tags: string[];
  status: "open" | "resolved" | null;
  authorId: string | null;
  q: string | null;
}): Promise<SharedPage> {
  const column = args.sort === "activity" ? "p.last_activity_at" : "p.created_at";
  const params: unknown[] = [args.forumId];
  const where: string[] = ["p.forum_id = $1", "p.published_at IS NOT NULL"];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  // Pinned posts sit on page 1 apart from the list and are never repeated in
  // it. A search shows them inline instead (the header hides `pinned` while
  // `q` is set), so a pinned post is still findable by its title.
  if (!args.q) {
    where.push("p.pinned_at IS NULL");
  }
  if (args.cursor) {
    where.push(
      `(${column}, p.channel_id) < (${param(args.cursor.at)}::timestamptz, ${param(args.cursor.id)}::uuid)`,
    );
  }
  if (args.tags.length > 0) {
    // AND: the post carries EVERY selected tag. One probe of
    // forum_post_tags' primary key per selected tag.
    const tags = param(args.tags);
    where.push(
      `(SELECT count(*) FROM forum_post_tags t
         WHERE t.post_id = p.channel_id AND t.tag_id = ANY(${tags}::uuid[]))
       = cardinality(${tags}::uuid[])`,
    );
  }
  if (args.status) {
    where.push(
      args.status === "resolved" ? "p.resolved_at IS NOT NULL" : "p.resolved_at IS NULL",
    );
  }
  if (args.authorId) {
    where.push(`p.author_id = ${param(args.authorId)}`);
  }
  let join = "";
  if (args.q) {
    const unaccent = await hasUnaccent();
    join = "JOIN channels c ON c.id = p.channel_id";
    where.push(
      `${foldSql("c.name", unaccent)} LIKE '%' || ${foldSql(`${param(escapeLike(args.q))}::text`, unaccent)} || '%' ESCAPE '\\'`,
    );
  }

  const ordered = await getPool().query<{ channel_id: string; sort_key: string }>(
    `SELECT p.channel_id, ${KEY_TEXT(column)} AS sort_key
       FROM forum_posts p
       ${join}
      WHERE ${where.join(" AND ")}
      ORDER BY ${column} DESC, p.channel_id DESC
      LIMIT ${param(args.limit + 1)}`,
    params,
  );
  const hasMore = ordered.rows.length > args.limit;
  const pageRows = ordered.rows.slice(0, args.limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ sort: args.sort, at: last.sort_key, id: last.channel_id })
      : null;

  const firstPage = args.cursor === null;
  const [pinnedIds, counts] = firstPage
    ? await Promise.all([
        args.q
          ? Promise.resolve([] as string[])
          : getPool()
              .query<{ channel_id: string }>(
                `SELECT channel_id FROM forum_posts
                  WHERE forum_id = $1 AND pinned_at IS NOT NULL
                    AND published_at IS NOT NULL
                  ORDER BY pinned_at ASC, channel_id ASC
                  LIMIT ${FORUM_MAX_PINNED}`,
                [args.forumId],
              )
              .then((result) => result.rows.map((row) => row.channel_id)),
        getPool()
          .query<{ posts: number; open: number }>(
            `SELECT count(*)::int AS posts,
                    count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
               FROM forum_posts
              WHERE forum_id = $1 AND published_at IS NOT NULL`,
            [args.forumId],
          )
          .then((result) => result.rows[0] ?? { posts: 0, open: 0 }),
      ])
    : [[] as string[], null];

  const summaries = await readForumPostSummaries([
    ...pinnedIds,
    ...pageRows.map((row) => row.channel_id),
  ]);
  const pinnedSet = new Set(pinnedIds);
  return {
    pinned: summaries.filter((post) => pinnedSet.has(post.id)),
    posts: summaries.filter((post) => !pinnedSet.has(post.id)),
    nextCursor,
    counts,
  };
}

// -------------------------------------------------------------- similar

/**
 * Words too common to say two titles are about the same thing. Only words of
 * three letters or more are ever compared, so the two-letter ones never
 * needed listing.
 */
const SIMILAR_STOP_WORDS = new Set([
  "que", "com", "para", "pra", "uma", "uns", "umas", "por", "mas", "dos",
  "das", "nos", "nas", "meu", "minha", "isso", "esse", "essa", "este",
  "esta", "tem", "como", "quando", "onde", "qual", "sobre", "the", "and",
  "for", "with", "how", "what", "why", "does", "not", "you", "can",
]);

/** The words of a title, folded the way the SQL folds the column. */
function similarWords(title: string, unaccent: boolean): string[] {
  const lowered = title.toLowerCase();
  const folded = unaccent
    ? lowered.normalize("NFD").replace(/\p{M}+/gu, "")
    : lowered;
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter(
    (word) => Array.from(word).length >= 3 && !SIMILAR_STOP_WORDS.has(word),
  );
  return [...new Set(words)].slice(0, 8);
}

/**
 * "Posts parecidos": posts of this forum whose titles share enough words
 * with the one being typed, resolved first (the answer is what the asker
 * wants), then by how many words matched, then by activity. "Enough" is one
 * word for a one- or two-word title and half of them past that, so a long
 * title does not drag in every post that says "erro".
 */
export async function similarForumPosts(
  forumId: string,
  title: string,
): Promise<ForumPostSummary[]> {
  const unaccent = await hasUnaccent();
  const words = similarWords(title, unaccent);
  if (words.length === 0) {
    return [];
  }
  const needed = words.length <= 2 ? 1 : Math.ceil(words.length / 2);
  const result = await getPool().query<{ channel_id: string }>(
    `SELECT channel_id FROM (
       SELECT p.channel_id, p.resolved_at, p.last_activity_at,
              (SELECT count(*) FROM unnest($2::text[]) AS w(word)
                WHERE ${foldSql("c.name", unaccent)} LIKE '%' || w.word || '%') AS hits
         FROM forum_posts p
         JOIN channels c ON c.id = p.channel_id
        WHERE p.forum_id = $1 AND p.published_at IS NOT NULL
     ) scored
     WHERE hits >= $3
     ORDER BY (resolved_at IS NOT NULL) DESC, hits DESC, last_activity_at DESC
     LIMIT ${FORUM_SIMILAR_MAX}`,
    [forumId, words, needed],
  );
  return readForumPostSummaries(result.rows.map((row) => row.channel_id));
}

// ---------------------------------------------------------- post rows

export interface ForumPostRow {
  channel_id: string;
  forum_id: string;
  server_id: string;
  title: string;
  author_id: string | null;
  opening_message_id: string | null;
  resolved_message_id: string | null;
  published_at: Date | null;
  pinned_at: Date | null;
  locked_at: Date | null;
  resolved_at: Date | null;
}

/** A published post, or null (a shell, a chat thread, anything else). */
export async function getForumPostRow(postId: string): Promise<ForumPostRow | null> {
  const result = await getPool().query<ForumPostRow>(
    `SELECT p.channel_id, p.forum_id, c.server_id, c.name AS title, p.author_id,
            p.opening_message_id, p.resolved_message_id, p.published_at,
            p.pinned_at, p.locked_at, p.resolved_at
       FROM forum_posts p
       JOIN channels c ON c.id = p.channel_id
      WHERE p.channel_id = $1 AND p.published_at IS NOT NULL`,
    [postId],
  );
  return result.rows[0] ?? null;
}

// --------------------------------------------------------------- detail

/**
 * The accepted answer for the post view. The id survives the reply being
 * deleted (no FK, on purpose), so a missing message reads `deleted: true` and
 * the post can say so instead of forgetting it ever had an answer.
 */
async function readAcceptedAnswer(
  postId: string,
  messageId: string,
): Promise<ForumAcceptedAnswer> {
  const result = await getPool().query<{
    author_id: string;
    author_name: string | null;
    body: string;
    created_at: Date;
  }>(
    `SELECT m.author_id, m.body, m.created_at,
            COALESCE(m.webhook_username, NULLIF(sm.nickname, ''), u.display_name)
              AS author_name
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN users u ON u.id = m.author_id
       LEFT JOIN server_members sm
         ON sm.user_id = m.author_id AND sm.server_id = c.server_id
      WHERE m.id = $1 AND m.channel_id = $2`,
    [messageId, postId],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      messageId,
      deleted: true,
      authorId: null,
      authorName: null,
      excerpt: null,
      createdAt: null,
    };
  }
  return {
    messageId,
    deleted: false,
    authorId: row.author_id,
    authorName: row.author_name,
    excerpt: flatten(row.body, FORUM_ANSWER_EXCERPT_MAX),
    createdAt: row.created_at.toISOString(),
  };
}

/** Distinct people who wrote in the post, the author always counted. */
async function readParticipantCount(postId: string): Promise<number> {
  const result = await getPool().query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
       SELECT author_id FROM messages WHERE channel_id = $1
       UNION
       SELECT author_id FROM forum_posts
        WHERE channel_id = $1 AND author_id IS NOT NULL
     ) people`,
    [postId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function getForumPostDetail(
  postId: string,
  viewerId: string,
): Promise<{
  post: ForumPostSummary;
  viewer: ForumPostViewer;
  acceptedAnswer: ForumAcceptedAnswer | null;
  participantCount: number;
} | null> {
  const post = await getForumPostSummary(postId);
  if (!post) {
    return null;
  }
  const [viewer, acceptedAnswer, participantCount] = await Promise.all([
    readForumPostViewers([postId], viewerId),
    post.acceptedAnswerId
      ? readAcceptedAnswer(postId, post.acceptedAnswerId)
      : Promise.resolve(null),
    readParticipantCount(postId),
  ]);
  return { post, viewer: viewer[0]!, acceptedAnswer, participantCount };
}

// ----------------------------------------------------------------- tags

interface TagRow {
  id: string;
  name: string;
  emoji: string | null;
  moderated: boolean;
  position: number;
  post_count: number;
}

function mapTag(row: TagRow): ForumTag {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    moderated: row.moderated,
    position: row.position,
    postCount: row.post_count,
  };
}

export async function listForumTags(
  forumId: string,
  runner: Pick<PoolClient, "query"> = getPool(),
): Promise<ForumTag[]> {
  const result = await runner.query<TagRow>(
    `SELECT t.id, t.name, t.emoji, t.moderated, t.position,
            (SELECT count(*) FROM forum_post_tags pt
               JOIN forum_posts p ON p.channel_id = pt.post_id
              WHERE pt.tag_id = t.id AND p.published_at IS NOT NULL)::int AS post_count
       FROM forum_tags t
      WHERE t.forum_id = $1
      ORDER BY t.position, t.created_at, t.id`,
    [forumId],
  );
  return result.rows.map(mapTag);
}

/**
 * Check a requested tag list against the forum's tags. Unknown ids are 400;
 * a staff-only tag being ADDED or REMOVED by somebody who is not staff is
 * 403. `previous` is the post's current list (empty for a new post), so a
 * member retagging their own post keeps a staff tag that was already on it
 * without being refused for it.
 */
export function checkTagChange(
  forumTags: readonly ForumTag[],
  requested: readonly string[],
  previous: readonly string[],
  isStaff: boolean,
): void {
  const byId = new Map(forumTags.map((tag) => [tag.id, tag]));
  for (const id of requested) {
    if (!byId.has(id)) {
      throw new ForumError(400, FORUM_ERRORS.tagUnknown);
    }
  }
  if (isStaff) {
    return;
  }
  const before = new Set(previous);
  const after = new Set(requested);
  const touched = [
    ...requested.filter((id) => !before.has(id)),
    ...previous.filter((id) => !after.has(id)),
  ];
  if (touched.some((id) => byId.get(id)?.moderated === true)) {
    throw new ForumError(403, FORUM_ERRORS.tagModerated);
  }
}

/**
 * Replace a forum's tag list (the PUT). An entry with `id` edits that tag, one
 * without creates a tag, a tag missing from the list is deleted along with
 * its post links. One transaction, under a per-forum advisory lock so two
 * editors saving at once serialise instead of interleaving.
 *
 * Renames go through a placeholder first. The name index is unique and
 * checked row by row, so swapping two names ("Bug" and "Dúvida") in one
 * UPDATE would trip on the first row; parking every renamed tag on a name no
 * person types makes any permutation legal.
 */
export async function replaceForumTags(
  forumId: string,
  request: PutForumTagsRequest,
): Promise<{ before: ForumTag[]; after: ForumTag[] }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('forum-tags:' || $1))`, [
      forumId,
    ]);
    const before = await listForumTags(forumId, client);
    const existing = new Map(before.map((tag) => [tag.id, tag]));
    for (const tag of request.tags) {
      if (tag.id && !existing.has(tag.id)) {
        throw new ForumError(400, FORUM_ERRORS.tagUnknown);
      }
    }
    const keptIds = request.tags.flatMap((tag) => (tag.id ? [tag.id] : []));
    await client.query(
      `DELETE FROM forum_tags WHERE forum_id = $1 AND id <> ALL($2::uuid[])`,
      [forumId, keptIds],
    );
    const renamed = request.tags.filter(
      (tag) => tag.id && existing.get(tag.id)!.name !== tag.name,
    );
    if (renamed.length > 0) {
      await client.query(
        `UPDATE forum_tags SET name = '~' || left(md5(id::text), 19)
          WHERE forum_id = $1 AND id = ANY($2::uuid[])`,
        [forumId, renamed.map((tag) => tag.id)],
      );
    }
    for (const [position, tag] of request.tags.entries()) {
      if (tag.id) {
        await client.query(
          `UPDATE forum_tags
              SET name = $3, emoji = $4, moderated = $5, position = $6
            WHERE forum_id = $1 AND id = $2`,
          [forumId, tag.id, tag.name, tag.emoji ?? null, tag.moderated, position],
        );
      } else {
        await client.query(
          `INSERT INTO forum_tags (forum_id, name, emoji, moderated, position)
           VALUES ($1, $2, $3, $4, $5)`,
          [forumId, tag.name, tag.emoji ?? null, tag.moderated, position],
        );
      }
    }
    const after = await listForumTags(forumId, client);
    await client.query("COMMIT");
    invalidateForumList(forumId);
    return { before, after };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------- settings

export async function getForumSettings(forumId: string): Promise<ForumSettings> {
  const result = await getPool().query<{ require_tag: boolean; default_sort: ForumSort }>(
    `SELECT require_tag, default_sort FROM forum_settings WHERE forum_id = $1`,
    [forumId],
  );
  const row = result.rows[0];
  return row
    ? { requireTag: row.require_tag, defaultSort: row.default_sort }
    : { ...FORUM_SETTINGS_DEFAULTS };
}

export async function updateForumSettings(
  forumId: string,
  patch: UpdateForumSettingsRequest,
): Promise<{ before: ForumSettings; after: ForumSettings }> {
  const before = await getForumSettings(forumId);
  const after: ForumSettings = {
    requireTag: patch.requireTag ?? before.requireTag,
    defaultSort: patch.defaultSort ?? before.defaultSort,
  };
  await getPool().query(
    `INSERT INTO forum_settings (forum_id, require_tag, default_sort, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (forum_id) DO UPDATE
       SET require_tag = EXCLUDED.require_tag,
           default_sort = EXCLUDED.default_sort,
           updated_at = NOW()`,
    [forumId, after.requireTag, after.defaultSort],
  );
  invalidateForumList(forumId);
  return { before, after };
}

// -------------------------------------------------------------- follows

/**
 * Follow or stop following. Stopping keeps a muted row rather than deleting
 * one, so the author's automatic follow (written when the post publishes)
 * never comes back after they turned it off. Inert until the P2 reply push.
 */
export async function setForumPostFollow(
  postId: string,
  userId: string,
  following: boolean,
): Promise<void> {
  await getPool().query(
    `INSERT INTO forum_post_follows (post_id, user_id, muted)
     VALUES ($1, $2, $3)
     ON CONFLICT (post_id, user_id) DO UPDATE SET muted = EXCLUDED.muted`,
    [postId, userId, !following],
  );
}

// ------------------------------------------------------- create (shell)

export interface CreateShellInput {
  forumId: string;
  serverId: string;
  /** Null for a webhook's post is NOT allowed: a pseudo user still has an id. */
  authorId: string;
  title: string;
  tagIds: readonly string[];
  /** Null for webhook posts, which dedupe instead (P1b). */
  nonce: string | null;
  dedupeKey?: string | null;
  /** Staged against the FORUM id by the composer; moved to the post here. */
  attachmentIds?: readonly string[];
}

export type CreateShellResult =
  | { kind: "created"; postId: string }
  /** The nonce already names a post of this author in this forum. */
  | { kind: "existing"; postId: string; published: boolean };

/**
 * Step one of a post: the thread channel, the `forum_posts` row with
 * `published_at` NULL (a shell nobody can list), its tags, and the composer's
 * staged attachments re-homed from the forum to the post, all in one
 * transaction. The opening message comes next, outside any transaction,
 * because its attachment claim HEADs the bucket (docs/ATTACHMENTS.md: nothing
 * between BEGIN and COMMIT touches the network).
 *
 * Why the re-home: uploads are minted per channel and the claim requires
 * `channel_id` to equal the message's channel, and the composer had no post
 * id to mint against. Only the caller's own unclaimed rows staged on this
 * forum move; anything else in the list is left where it is and the claim
 * then drops it, the same as a bad id in a chat send.
 *
 * A nonce that already names a post returns it instead of a second one.
 */
export async function createForumPostShell(
  input: CreateShellInput,
): Promise<CreateShellResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const channel = await client.query<{ id: string }>(
      `INSERT INTO channels
         (server_id, name, type, position, is_private, kind, parent_id, thread_root_message_id)
       VALUES ($1, $2, 'thread', 0, FALSE, 'server', $3, NULL)
       RETURNING id`,
      [input.serverId, input.title, input.forumId],
    );
    const postId = channel.rows[0]!.id;
    const post = await client.query(
      `INSERT INTO forum_posts (channel_id, forum_id, author_id, client_nonce, dedupe_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (forum_id, author_id, client_nonce)
         WHERE client_nonce IS NOT NULL
       DO NOTHING`,
      [postId, input.forumId, input.authorId, input.nonce, input.dedupeKey ?? null],
    );
    if ((post.rowCount ?? 0) === 0) {
      // The nonce is taken: drop the channel row this attempt made and hand
      // back the one that exists.
      await client.query("ROLLBACK");
      const existing = await getPool().query<{
        channel_id: string;
        published_at: Date | null;
      }>(
        `SELECT channel_id, published_at FROM forum_posts
          WHERE forum_id = $1 AND author_id = $2 AND client_nonce = $3`,
        [input.forumId, input.authorId, input.nonce],
      );
      const row = existing.rows[0];
      if (!row) {
        // Deleted between the conflict and this read (the shell sweep, or a
        // rejection being cleaned up). The client's retry creates it afresh.
        throw new ForumError(409, "Post is being created");
      }
      return {
        kind: "existing",
        postId: row.channel_id,
        published: row.published_at !== null,
      };
    }
    if (input.tagIds.length > 0) {
      await client.query(
        `INSERT INTO forum_post_tags (post_id, tag_id)
         SELECT $1, unnest($2::uuid[])`,
        [postId, input.tagIds],
      );
    }
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      await client.query(
        `UPDATE message_attachments
            SET channel_id = $1
          WHERE id = ANY($2::uuid[])
            AND uploader_id = $3
            AND channel_id = $4
            AND message_id IS NULL`,
        [postId, input.attachmentIds, input.authorId, input.forumId],
      );
    }
    await client.query("COMMIT");
    return { kind: "created", postId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Step three: the opening message landed, so the post becomes visible. The
 * author follows their own post (a muted row they left earlier is kept).
 */
export async function publishForumPost(
  postId: string,
  openingMessageId: string,
): Promise<void> {
  const result = await getPool().query<{ forum_id: string; author_id: string | null }>(
    `UPDATE forum_posts
        SET opening_message_id = $2, published_at = NOW(), last_activity_at = NOW()
      WHERE channel_id = $1 AND published_at IS NULL
      RETURNING forum_id, author_id`,
    [postId, openingMessageId],
  );
  const row = result.rows[0];
  if (row?.author_id) {
    await getPool().query(
      `INSERT INTO forum_post_follows (post_id, user_id)
       SELECT $1, $2 FROM users WHERE id = $2 AND NOT is_webhook
       ON CONFLICT (post_id, user_id) DO NOTHING`,
      [postId, row.author_id],
    );
  }
  if (row) {
    invalidateForumList(row.forum_id);
  }
}

/**
 * A rejected opening message: give the staged files back to the forum (so the
 * composer's retry can still claim them, and `deleteChannel` does not delete
 * their objects with the shell), then delete the shell.
 */
export async function discardForumPostShell(
  postId: string,
  forumId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE message_attachments SET channel_id = $2
      WHERE channel_id = $1 AND message_id IS NULL`,
    [postId, forumId],
  );
  await deleteChannel(postId);
}

/**
 * Shells older than `FORUM_SHELL_TTL_MS`: a create that crashed between the
 * shell and the opening message. Nobody can see one, so this is hygiene; a
 * batch per tick keeps a backlog from becoming one long burst of deletes.
 */
export async function sweepForumPostShells(): Promise<number> {
  const result = await getPool().query<{ channel_id: string; forum_id: string }>(
    `SELECT channel_id, forum_id FROM forum_posts
      WHERE published_at IS NULL
        AND created_at < NOW() - make_interval(secs => $1::int)
      ORDER BY created_at
      LIMIT 100`,
    [Math.floor(FORUM_SHELL_TTL_MS / 1000)],
  );
  let removed = 0;
  for (const row of result.rows) {
    await discardForumPostShell(row.channel_id, row.forum_id);
    removed += 1;
  }
  return removed;
}

// ----------------------------------------------------------------- bump

/**
 * The bump, called by the send path for every message in a `thread`
 * channel. For a chat thread it is a primary-key probe that matches nothing;
 * for a shell (the opening message itself) it matches nothing either, since
 * publishing sets the time. `GREATEST` makes it order-free, so it may run
 * outside the message transaction and two concurrent replies cannot move it
 * backwards. Returns the forum id when a post moved.
 */
export async function bumpForumPostActivity(
  postId: string,
  at: Date,
): Promise<string | null> {
  const result = await getPool().query<{ forum_id: string }>(
    `UPDATE forum_posts
        SET last_activity_at = GREATEST(last_activity_at, $2)
      WHERE channel_id = $1 AND published_at IS NOT NULL
      RETURNING forum_id`,
    [postId, at],
  );
  const forumId = result.rows[0]?.forum_id ?? null;
  if (forumId) {
    invalidateForumList(forumId);
  }
  return forumId;
}

// ---------------------------------------------------------------- patch

export interface ForumPostPatch {
  title?: string;
  tagIds?: readonly string[];
  /** `resolved_at` and `resolved_message_id` as they should end up. */
  resolvedAt?: "now" | null;
  acceptedAnswerId?: string | null;
  pinned?: boolean;
  locked?: boolean;
}

/**
 * Apply an already authorised patch. Pinning runs under a per-forum advisory
 * lock and counts inside the same transaction, so two moderators pinning the
 * third and fourth post at once cannot both win.
 */
export async function applyForumPostPatch(
  post: ForumPostRow,
  patch: ForumPostPatch,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (patch.pinned === true && post.pinned_at === null) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('forum-pins:' || $1))`, [
        post.forum_id,
      ]);
      const pinned = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM forum_posts
          WHERE forum_id = $1 AND pinned_at IS NOT NULL AND published_at IS NOT NULL`,
        [post.forum_id],
      );
      if ((pinned.rows[0]?.count ?? 0) >= FORUM_MAX_PINNED) {
        throw new ForumError(409, FORUM_ERRORS.pinLimit, { max: FORUM_MAX_PINNED });
      }
    }
    if (patch.title !== undefined) {
      await client.query(`UPDATE channels SET name = $2 WHERE id = $1`, [
        post.channel_id,
        patch.title,
      ]);
    }
    const sets: string[] = [];
    const params: unknown[] = [post.channel_id];
    if (patch.pinned !== undefined) {
      sets.push(
        patch.pinned ? "pinned_at = COALESCE(pinned_at, NOW())" : "pinned_at = NULL",
      );
    }
    if (patch.locked !== undefined) {
      sets.push(
        patch.locked ? "locked_at = COALESCE(locked_at, NOW())" : "locked_at = NULL",
      );
    }
    if (patch.resolvedAt !== undefined) {
      sets.push(
        patch.resolvedAt === "now"
          ? "resolved_at = COALESCE(resolved_at, NOW())"
          : "resolved_at = NULL",
      );
    }
    if (patch.acceptedAnswerId !== undefined) {
      params.push(patch.acceptedAnswerId);
      sets.push(`resolved_message_id = $${params.length}::uuid`);
    }
    if (sets.length > 0) {
      await client.query(
        `UPDATE forum_posts SET ${sets.join(", ")} WHERE channel_id = $1`,
        params,
      );
    }
    if (patch.tagIds !== undefined) {
      await client.query(`DELETE FROM forum_post_tags WHERE post_id = $1`, [
        post.channel_id,
      ]);
      if (patch.tagIds.length > 0) {
        await client.query(
          `INSERT INTO forum_post_tags (post_id, tag_id)
           SELECT $1, unnest($2::uuid[])`,
          [post.channel_id, patch.tagIds],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  invalidateForumList(post.forum_id);
}

/** The current tag ids of a post, for the moderated-tag diff. */
export async function getForumPostTagIds(postId: string): Promise<string[]> {
  const result = await getPool().query<{ tag_id: string }>(
    `SELECT tag_id FROM forum_post_tags WHERE post_id = $1`,
    [postId],
  );
  return result.rows.map((row) => row.tag_id);
}

/** Whether a message is a reply in this post (not its opening message). */
export async function isReplyInPost(
  post: ForumPostRow,
  messageId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2`,
    [messageId, post.channel_id],
  );
  return (result.rowCount ?? 0) > 0 && messageId !== post.opening_message_id;
}

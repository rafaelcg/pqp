import { randomUUID } from "node:crypto";
import {
  COMMUNITY_HOME_COMMENTS_LIMIT,
  COMMUNITY_HOME_FEED_LIMIT,
  COMMUNITY_HOME_MAX_BYTES,
  communityHomeMediaKindFromContentType,
  hasPermission,
  parseYoutubeVideoId,
  Permission,
  type CommunityHomeAuthorBadge,
  type CommunityHomeComment,
  type CommunityHomeContentType,
  type CommunityHomeMedia,
  type CommunityHomePost,
  type CommunityHomePostStatus,
  type CommunityHomeVisibility,
  type PublicUser,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import {
  deleteObject,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";
import {
  computeMemberPermissions,
  listServerMemberIds,
  memberHasPermission,
} from "./permissions.js";
import { toPublicUserSummary } from "./users.js";

/**
 * Community Home (Baú): durable posts, flat comments, likes, schedule.
 *
 * Visibility is enforced here — members-only body/media never leave the
 * service for a viewer who is neither MANAGE_SERVER nor VIP. Drafts and
 * scheduled posts are omitted from member list reads entirely.
 */

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const READ_URL_TTL_SECONDS = 12 * 60 * 60;
const ORPHAN_GRACE = "1 hour";
const SWEEP_BATCH = 200;

const EXTENSION_BY_CONTENT_TYPE: Record<CommunityHomeContentType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
};

/**
 * The instance flag for Baú, read per call like `isCommunitiesEnabled`.
 *
 * Deliberately NOT `COMMUNITIES_ENABLED`: that one changes the instance's
 * legal category (STF Art. 19). This one only says whether the Baú surface
 * exists here. Off means every `/home/*` route answers 404, the schedule
 * sweep stays idle, and the client hides the row. Default off.
 */
export function isCommunityHomeEnabled(): boolean {
  return process.env.COMMUNITY_HOME_ENABLED === "true";
}

/**
 * The VIP half, separately switchable so the free feed can ship first and
 * measure appetite. Off means: no `members` posts can be created or edited
 * into existence, existing ones are hidden from the member feed (staff still
 * see them in drafts), and the client shows no lock, no tier chip and no
 * "preview as" inspector. Requires the main flag; on its own it does nothing.
 */
export function isCommunityHomeVipEnabled(): boolean {
  return isCommunityHomeEnabled() && process.env.COMMUNITY_HOME_VIP_ENABLED === "true";
}

export function isCommunityHomeMediaConfigured(): boolean {
  return isStorageConfigured();
}

export class CommunityHomeError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid"
      | "over_limit"
      | "storage_off"
      | "bad_youtube"
      | "needs_content"
      | "needs_title"
      | "not_verified",
    message: string,
  ) {
    super(message);
    this.name = "CommunityHomeError";
  }
}

interface PostRow {
  id: string;
  server_id: string;
  author_id: string;
  title: string | null;
  body: string;
  teaser: string | null;
  visibility: CommunityHomeVisibility;
  status: CommunityHomePostStatus;
  comments_enabled: boolean;
  media_kind: "image" | "video" | "youtube" | "file" | null;
  media_name: string | null;
  media_content_type: string | null;
  media_byte_size: string | null;
  media_storage_key: string | null;
  media_youtube_url: string | null;
  scheduled_at: Date | null;
  schedule_timezone: string | null;
  pinned_at: Date | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  display_name: string;
  username: string | null;
  discriminator: string | null;
  avatar_url: string | null;
  like_count: string;
  liked_by_me: boolean;
  comment_count: string;
  server_owner_id: string;
}

interface CommentRow {
  id: string;
  body: string;
  created_at: Date;
  author_id: string;
  display_name: string;
  username: string | null;
  discriminator: string | null;
  avatar_url: string | null;
}

/**
 * A comment written by somebody the viewer has blocked is not theirs to
 * read, and must not be counted either: a card that says "3 comments" and
 * shows two is how a blocked person keeps a presence on your screen.
 *
 * One direction only, like the rest of the product: blocking hides them from
 * you, not you from them. Applied in SQL rather than after the fact so the
 * count, the teaser and the full list can never disagree.
 */
function notBlockedSql(viewerParam: string): string {
  return `AND NOT EXISTS (
    SELECT 1 FROM user_blocks b
     WHERE b.user_id = ${viewerParam} AND b.blocked_user_id = c.author_id
  )`;
}

/** `$1` = viewer id in the liked_by_me subquery. Caller supplies the rest. */
function postSelectSql(viewerParam: string): string {
  return `
  p.id, p.server_id, p.author_id, p.title, p.body, p.teaser, p.visibility,
  p.status, p.comments_enabled, p.media_kind, p.media_name, p.media_content_type,
  p.media_byte_size, p.media_storage_key, p.media_youtube_url,
  p.scheduled_at, p.schedule_timezone, p.pinned_at, p.published_at,
  p.created_at, p.updated_at,
  u.display_name, u.username, u.discriminator, u.avatar_url,
  s.owner_id AS server_owner_id,
  (SELECT COUNT(*)::text FROM community_home_likes l WHERE l.post_id = p.id) AS like_count,
  EXISTS(
    SELECT 1 FROM community_home_likes l
     WHERE l.post_id = p.id AND l.user_id = ${viewerParam}
  ) AS liked_by_me,
  (SELECT COUNT(*)::text FROM community_home_comments c
    WHERE c.post_id = p.id ${notBlockedSql(viewerParam)}) AS comment_count
  FROM community_home_posts p
  JOIN users u ON u.id = p.author_id
  JOIN servers s ON s.id = p.server_id
`;
}

function authorFromRow(row: PostRow | CommentRow): PublicUser {
  return toPublicUserSummary({
    id: row.author_id,
    display_name: row.display_name,
    username: row.username,
    discriminator: row.discriminator,
    avatar_url: row.avatar_url,
  });
}

export type HomeViewerCaps = {
  canManage: boolean;
  isVip: boolean;
  isOwner: boolean;
  /** Carried so the hydrators can filter by this viewer's block list. */
  viewerId: string;
};

export async function resolveHomeViewerCaps(
  serverId: string,
  userId: string,
): Promise<HomeViewerCaps> {
  const perms = await computeMemberPermissions(serverId, userId);
  const canManage = hasPermission(perms, Permission.MANAGE_SERVER);
  const pool = getPool();
  const owner = await pool.query<{ owner_id: string }>(
    `SELECT owner_id FROM servers WHERE id = $1`,
    [serverId],
  );
  const isOwner = owner.rows[0]?.owner_id === userId;
  const vip = await pool.query<{ ok: boolean }>(
    `SELECT TRUE AS ok
       FROM member_roles mr
       JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = $1 AND mr.user_id = $2 AND r.system_key = 'vip'
      LIMIT 1`,
    [serverId, userId],
  );
  return {
    canManage,
    isVip: Boolean(vip.rows[0]),
    isOwner,
    viewerId: userId,
  };
}

function canUnlockMembers(
  caps: HomeViewerCaps,
): boolean {
  return caps.canManage || caps.isVip;
}

function authorBadgeFor(
  row: PostRow,
  authorCaps: { canManage: boolean; isOwner: boolean } | null,
): CommunityHomeAuthorBadge | null {
  if (row.author_id === row.server_owner_id || authorCaps?.isOwner) {
    return "owner";
  }
  if (authorCaps?.canManage) {
    return "staff";
  }
  // Authors of Home posts are staff by product rule; if somehow not, no chip.
  return null;
}

function buildMedia(
  row: PostRow,
  unlocked: boolean,
): CommunityHomeMedia | null {
  if (!unlocked || !row.media_kind) {
    return null;
  }
  if (row.media_kind === "youtube") {
    return {
      kind: "youtube",
      name: row.media_name ?? "YouTube",
      contentType: null,
      byteSize: null,
      url: null,
      youtubeUrl: row.media_youtube_url,
    };
  }
  let url: string | null = null;
  if (row.media_storage_key && isStorageConfigured()) {
    try {
      url = presignGet(row.media_storage_key, {
        ttlSeconds: READ_URL_TTL_SECONDS,
        // Same rule as attachments: anything that is not an inline image or
        // video is signed as a download, so a PDF never renders as a
        // top-level document on the bucket's origin.
        ...(row.media_kind === "file" && row.media_name
          ? { downloadFilename: row.media_name }
          : {}),
      });
    } catch {
      url = null;
    }
  }
  return {
    kind: row.media_kind,
    name: row.media_name ?? "file",
    contentType: row.media_content_type,
    byteSize: row.media_byte_size ? Number(row.media_byte_size) : null,
    url,
    youtubeUrl: null,
  };
}

function toComment(row: CommentRow): CommunityHomeComment {
  return {
    id: row.id,
    author: authorFromRow(row),
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadCommentTeasers(
  postIds: string[],
  viewerId: string,
): Promise<Map<string, CommunityHomeComment[]>> {
  const map = new Map<string, CommunityHomeComment[]>();
  if (postIds.length === 0) {
    return map;
  }
  // Card teaser: up to 2. Prefer post-author replies (oldest first); else
  // oldest overall. Newest accordion is out of the chrome lock. Blocked
  // authors stay out of the card the same way they stay out of the full list.
  const result = await getPool().query<CommentRow & { post_id: string }>(
    `WITH comments AS (
       SELECT c.id, c.post_id, c.body, c.created_at, c.author_id,
              u.display_name, u.username, u.discriminator, u.avatar_url,
              (c.author_id = p.author_id) AS is_owner_reply
         FROM community_home_comments c
         JOIN community_home_posts p ON p.id = c.post_id
         JOIN users u ON u.id = c.author_id
        WHERE c.post_id = ANY($1::uuid[]) ${notBlockedSql("$2")}
     ),
     has_owner AS (
       SELECT post_id, BOOL_OR(is_owner_reply) AS any_owner
         FROM comments
        GROUP BY post_id
     ),
     ranked AS (
       SELECT c.id, c.post_id, c.body, c.created_at, c.author_id,
              c.display_name, c.username, c.discriminator, c.avatar_url,
              ROW_NUMBER() OVER (
                PARTITION BY c.post_id
                ORDER BY c.created_at ASC
              ) AS rn
         FROM comments c
         JOIN has_owner h ON h.post_id = c.post_id
        WHERE (h.any_owner AND c.is_owner_reply)
           OR (NOT h.any_owner)
     )
     SELECT id, post_id, body, created_at, author_id,
            display_name, username, discriminator, avatar_url
       FROM ranked
      WHERE rn <= 2
      ORDER BY created_at ASC`,
    [postIds, viewerId],
  );
  for (const row of result.rows) {
    const list = map.get(row.post_id) ?? [];
    list.push(toComment(row));
    map.set(row.post_id, list);
  }
  return map;
}

async function authorBadgeMap(
  serverId: string,
  authorIds: string[],
): Promise<Map<string, { canManage: boolean; isOwner: boolean }>> {
  const map = new Map<string, { canManage: boolean; isOwner: boolean }>();
  await Promise.all(
    [...new Set(authorIds)].map(async (id) => {
      const caps = await resolveHomeViewerCaps(serverId, id);
      map.set(id, { canManage: caps.canManage, isOwner: caps.isOwner });
    }),
  );
  return map;
}

function toPost(
  row: PostRow,
  caps: HomeViewerCaps,
  teaser: CommunityHomeComment[],
  authorCaps: { canManage: boolean; isOwner: boolean } | null,
): CommunityHomePost {
  const locked =
    row.visibility === "members" && !canUnlockMembers(caps);
  return {
    id: row.id,
    serverId: row.server_id,
    author: authorFromRow(row),
    authorBadge: authorBadgeFor(row, authorCaps),
    title: row.title,
    body: locked ? null : row.body,
    teaser: row.teaser,
    visibility: row.visibility,
    status: row.status,
    commentsEnabled: row.comments_enabled,
    media: buildMedia(row, !locked),
    locked,
    likeCount: Number(row.like_count),
    likedByMe: row.liked_by_me,
    commentCount: Number(row.comment_count),
    // A locked viewer gets the count but not the words: a comment on a VIP
    // post can quote the clip, and that is the exact thing the lock hides.
    commentTeaser: locked ? [] : teaser,
    pinned: row.pinned_at != null,
    scheduledAt: row.scheduled_at?.toISOString() ?? null,
    scheduleTimezone: row.schedule_timezone,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function hydratePosts(
  rows: PostRow[],
  caps: HomeViewerCaps,
): Promise<CommunityHomePost[]> {
  if (rows.length === 0) {
    return [];
  }
  const serverId = rows[0]!.server_id;
  const [teasers, badges] = await Promise.all([
    loadCommentTeasers(
      rows.map((r) => r.id),
      caps.viewerId,
    ),
    authorBadgeMap(
      serverId,
      rows.map((r) => r.author_id),
    ),
  ]);
  return rows.map((row) =>
    toPost(
      row,
      caps,
      teasers.get(row.id) ?? [],
      badges.get(row.author_id) ?? null,
    ),
  );
}

export async function listCommunityHomePosts(
  serverId: string,
  viewerId: string,
): Promise<CommunityHomePost[]> {
  const caps = await resolveHomeViewerCaps(serverId, viewerId);
  // Feed is published-only for everyone. Drafts/scheduled live in the staff
  // overflow via listCommunityHomeDrafts — never mixed into the member feed.
  // With VIP off, members-only rows stay out of the feed for everybody,
  // staff included. They are still reachable through the drafts list so an
  // owner can flip them to free rather than lose them.
  const visibilityFilter = isCommunityHomeVipEnabled()
    ? ""
    : " AND p.visibility = 'free'";
  const result = await getPool().query<PostRow>(
    `SELECT ${postSelectSql("$1")}
      WHERE p.server_id = $2 AND p.status = 'published'${visibilityFilter}
      -- The pinned post first, whatever its date: it is there to be the first
      -- thing a new member reads. Everything else newest first, as before.
      ORDER BY p.pinned_at IS NULL, p.published_at DESC NULLS LAST,
               p.created_at DESC
      LIMIT $3`,
    [viewerId, serverId, COMMUNITY_HOME_FEED_LIMIT],
  );
  return hydratePosts(result.rows, caps);
}

/**
 * Keep one post at the top of this server's feed, or let it go.
 *
 * Pinning unpins whatever was pinned before, in the same transaction, so the
 * unique index in `schema.sql` never has to reject anything. Only a published
 * post can be pinned: a pinned draft would be a top slot nobody can see.
 */
export async function setCommunityHomePostPinned(
  serverId: string,
  postId: string,
  actorId: string,
  pinned: boolean,
): Promise<CommunityHomePost> {
  const canManage = await memberHasPermission(
    serverId,
    actorId,
    Permission.MANAGE_SERVER,
  );
  if (!canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ status: CommunityHomePostStatus }>(
      `SELECT status FROM community_home_posts
        WHERE id = $1 AND server_id = $2
        FOR UPDATE`,
      [postId, serverId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new CommunityHomeError("not_found", "Post not found");
    }
    if (pinned && row.status !== "published") {
      throw new CommunityHomeError(
        "invalid",
        "Only a published post can be pinned",
      );
    }
    if (pinned) {
      await client.query(
        `UPDATE community_home_posts SET pinned_at = NULL, updated_at = NOW()
          WHERE server_id = $1 AND pinned_at IS NOT NULL AND id <> $2`,
        [serverId, postId],
      );
    }
    await client.query(
      `UPDATE community_home_posts
          SET pinned_at = $3, updated_at = NOW()
        WHERE id = $1 AND server_id = $2`,
      [postId, serverId, pinned ? new Date().toISOString() : null],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getCommunityHomePost(serverId, postId, actorId);
}

/**
 * How many published posts landed since this person last opened the feed.
 *
 * Their own posts never count — an owner does not need a badge telling them
 * they posted — and the VIP filter matches the feed, so the number can never
 * promise a post the feed will not show. No read row means everything is
 * unread, which is the honest answer for somebody who has never opened it.
 */
export async function countUnreadCommunityHomePosts(
  serverId: string,
  viewerId: string,
): Promise<number> {
  const visibilityFilter = isCommunityHomeVipEnabled()
    ? ""
    : " AND p.visibility = 'free'";
  const result = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM community_home_posts p
       LEFT JOIN community_home_reads r
         ON r.server_id = p.server_id AND r.user_id = $1
      WHERE p.server_id = $2
        AND p.status = 'published'
        AND p.author_id <> $1
        AND (r.last_seen_at IS NULL OR p.published_at > r.last_seen_at)
        ${visibilityFilter}`,
    [viewerId, serverId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Stamp the feed as read up to now. Never fans out: it is one person's mark. */
export async function markCommunityHomeRead(
  serverId: string,
  viewerId: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO community_home_reads (server_id, user_id, last_seen_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (server_id, user_id)
     DO UPDATE SET last_seen_at = NOW()`,
    [serverId, viewerId],
  );
}

export async function listCommunityHomeDrafts(
  serverId: string,
  viewerId: string,
): Promise<CommunityHomePost[]> {
  const caps = await resolveHomeViewerCaps(serverId, viewerId);
  if (!caps.canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }
  const result = await getPool().query<PostRow>(
    `SELECT ${postSelectSql("$1")}
      WHERE p.server_id = $2 AND p.status IN ('draft', 'scheduled')
      ORDER BY p.updated_at DESC
      LIMIT $3`,
    [viewerId, serverId, COMMUNITY_HOME_FEED_LIMIT],
  );
  return hydratePosts(result.rows, caps);
}

export async function getCommunityHomePost(
  serverId: string,
  postId: string,
  viewerId: string,
): Promise<CommunityHomePost> {
  const caps = await resolveHomeViewerCaps(serverId, viewerId);
  const result = await getPool().query<PostRow>(
    `SELECT ${postSelectSql("$1")}
      WHERE p.server_id = $2 AND p.id = $3`,
    [viewerId, serverId, postId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CommunityHomeError("not_found", "Post not found");
  }
  if (
    (row.status === "draft" || row.status === "scheduled") &&
    !caps.canManage
  ) {
    throw new CommunityHomeError("not_found", "Post not found");
  }
  const [post] = await hydratePosts([row], caps);
  return post!;
}

type MediaFields = {
  media_kind: "image" | "video" | "youtube" | "file" | null;
  media_name: string | null;
  media_content_type: string | null;
  media_byte_size: number | null;
  media_storage_key: string | null;
  media_youtube_url: string | null;
};

async function claimUploadOntoPost(
  client: PoolClient,
  serverId: string,
  uploaderId: string,
  uploadId: string,
  postId: string,
): Promise<MediaFields> {
  const result = await client.query<{
    id: string;
    storage_key: string;
    filename: string;
    content_type: string;
    byte_size: string;
    kind: "image" | "video" | "file";
    verified_at: Date | null;
    uploader_id: string;
    server_id: string;
  }>(
    `SELECT id, storage_key, filename, content_type, byte_size, kind,
            verified_at, uploader_id, server_id
       FROM community_home_media_uploads
      WHERE id = $1
      FOR UPDATE`,
    [uploadId],
  );
  const upload = result.rows[0];
  if (!upload || upload.server_id !== serverId || upload.uploader_id !== uploaderId) {
    throw new CommunityHomeError("not_found", "Media upload not found");
  }
  if (!upload.verified_at) {
    throw new CommunityHomeError(
      "not_verified",
      "Claim the media upload before attaching it",
    );
  }
  await client.query(
    `UPDATE community_home_media_uploads
        SET claimed_post_id = $2
      WHERE id = $1`,
    [uploadId, postId],
  );
  return {
    media_kind: upload.kind,
    media_name: upload.filename,
    media_content_type: upload.content_type,
    media_byte_size: Number(upload.byte_size),
    media_storage_key: upload.storage_key,
    media_youtube_url: null,
  };
}

function youtubeMedia(url: string): MediaFields {
  if (!parseYoutubeVideoId(url)) {
    throw new CommunityHomeError("bad_youtube", "Invalid YouTube URL");
  }
  return {
    media_kind: "youtube",
    media_name: "YouTube",
    media_content_type: null,
    media_byte_size: null,
    media_storage_key: null,
    media_youtube_url: url.trim(),
  };
}

function emptyMedia(): MediaFields {
  return {
    media_kind: null,
    media_name: null,
    media_content_type: null,
    media_byte_size: null,
    media_storage_key: null,
    media_youtube_url: null,
  };
}

function assertPublishable(input: {
  title: string | null;
  body: string;
  media: MediaFields;
  status: CommunityHomePostStatus;
}): void {
  if (input.status === "draft") {
    return;
  }
  if (!input.title?.trim()) {
    throw new CommunityHomeError("needs_title", "Title is required to publish");
  }
  const hasBody = Boolean(input.body.trim());
  const hasMedia = input.media.media_kind != null;
  if (!hasBody && !hasMedia) {
    throw new CommunityHomeError(
      "needs_content",
      "Add a body or media to publish",
    );
  }
}

function assertVisibilityAllowed(visibility: CommunityHomeVisibility): void {
  if (visibility === "members" && !isCommunityHomeVipEnabled()) {
    throw new CommunityHomeError(
      "invalid",
      "VIP posts are off on this instance",
    );
  }
}

export type CreateHomePostInput = {
  title: string | null;
  body: string;
  teaser: string | null;
  visibility: CommunityHomeVisibility;
  commentsEnabled: boolean;
  mediaUploadId: string | null;
  youtubeUrl: string | null;
  status: CommunityHomePostStatus;
  scheduledAt: string | null;
  scheduleTimezone: string | null;
};

export async function createCommunityHomePost(
  serverId: string,
  authorId: string,
  input: CreateHomePostInput,
): Promise<CommunityHomePost> {
  const canManage = await memberHasPermission(
    serverId,
    authorId,
    Permission.MANAGE_SERVER,
  );
  if (!canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }

  if (input.mediaUploadId && input.youtubeUrl) {
    throw new CommunityHomeError("invalid", "Pick one media source");
  }
  assertVisibilityAllowed(input.visibility);

  const status = input.status;
  if (status === "scheduled") {
    if (!input.scheduledAt || !input.scheduleTimezone) {
      throw new CommunityHomeError(
        "invalid",
        "Schedule needs a time and timezone",
      );
    }
    if (new Date(input.scheduledAt).getTime() <= Date.now()) {
      throw new CommunityHomeError(
        "invalid",
        "Schedule time must be in the future",
      );
    }
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO community_home_posts (
         server_id, author_id, title, body, teaser, visibility, status,
         comments_enabled, scheduled_at, schedule_timezone, published_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       ) RETURNING id`,
      [
        serverId,
        authorId,
        input.title,
        input.body,
        input.visibility === "members" ? input.teaser : null,
        input.visibility,
        status === "scheduled" ? "scheduled" : status === "published" ? "published" : "draft",
        input.commentsEnabled,
        status === "scheduled" ? input.scheduledAt : null,
        status === "scheduled" ? input.scheduleTimezone : null,
        status === "published" ? new Date().toISOString() : null,
      ],
    );
    const postId = inserted.rows[0]!.id;

    let media = emptyMedia();
    if (input.mediaUploadId) {
      media = await claimUploadOntoPost(
        client,
        serverId,
        authorId,
        input.mediaUploadId,
        postId,
      );
    } else if (input.youtubeUrl) {
      media = youtubeMedia(input.youtubeUrl);
    }

    assertPublishable({
      title: input.title,
      body: input.body,
      media,
      status:
        status === "scheduled"
          ? "scheduled"
          : status === "published"
            ? "published"
            : "draft",
    });

    await client.query(
      `UPDATE community_home_posts SET
         media_kind = $2,
         media_name = $3,
         media_content_type = $4,
         media_byte_size = $5,
         media_storage_key = $6,
         media_youtube_url = $7,
         updated_at = NOW()
       WHERE id = $1`,
      [
        postId,
        media.media_kind,
        media.media_name,
        media.media_content_type,
        media.media_byte_size,
        media.media_storage_key,
        media.media_youtube_url,
      ],
    );
    await client.query("COMMIT");
    return getCommunityHomePost(serverId, postId, authorId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type UpdateHomePostInput = {
  title?: string | null;
  body?: string | null;
  teaser?: string | null;
  visibility?: CommunityHomeVisibility;
  commentsEnabled?: boolean;
  mediaUploadId?: string | null;
  youtubeUrl?: string | null;
  clearMedia?: boolean;
};

export async function updateCommunityHomePost(
  serverId: string,
  postId: string,
  actorId: string,
  input: UpdateHomePostInput,
): Promise<CommunityHomePost> {
  const canManage = await memberHasPermission(
    serverId,
    actorId,
    Permission.MANAGE_SERVER,
  );
  if (!canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{
      id: string;
      visibility: CommunityHomeVisibility;
      status: CommunityHomePostStatus;
      title: string | null;
      body: string;
      teaser: string | null;
      media_kind: string | null;
      media_name: string | null;
      media_content_type: string | null;
      media_byte_size: string | null;
      media_storage_key: string | null;
      media_youtube_url: string | null;
    }>(
      `SELECT id, visibility, status, title, body, teaser,
              media_kind, media_name, media_content_type, media_byte_size,
              media_storage_key, media_youtube_url
         FROM community_home_posts
        WHERE id = $1 AND server_id = $2
        FOR UPDATE`,
      [postId, serverId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new CommunityHomeError("not_found", "Post not found");
    }

    let media: MediaFields = {
      media_kind: row.media_kind as MediaFields["media_kind"],
      media_name: row.media_name,
      media_content_type: row.media_content_type,
      media_byte_size: row.media_byte_size ? Number(row.media_byte_size) : null,
      media_storage_key: row.media_storage_key,
      media_youtube_url: row.media_youtube_url,
    };

    const previousKey = row.media_storage_key;
    if (input.clearMedia) {
      media = emptyMedia();
    } else if (input.mediaUploadId) {
      media = await claimUploadOntoPost(
        client,
        serverId,
        actorId,
        input.mediaUploadId,
        postId,
      );
    } else if (input.youtubeUrl) {
      media = youtubeMedia(input.youtubeUrl);
    } else if (input.youtubeUrl === null && input.mediaUploadId === null) {
      // explicit clear via nullable fields when clearMedia not set — leave
    }

    const visibility = input.visibility ?? row.visibility;
    if (input.visibility !== undefined) {
      assertVisibilityAllowed(visibility);
    }
    const title = input.title !== undefined ? input.title : row.title;
    const body = input.body !== undefined ? (input.body ?? "") : row.body;
    // An edit that does not mention the teaser keeps the one already saved;
    // only flipping the post to free clears it.
    const teaser =
      visibility === "members"
        ? input.teaser !== undefined
          ? input.teaser
          : row.teaser
        : null;

    if (row.status === "published" || row.status === "scheduled") {
      assertPublishable({
        title,
        body,
        media,
        status: row.status,
      });
    }

    await client.query(
      `UPDATE community_home_posts SET
         title = $3,
         body = $4,
         teaser = $5,
         visibility = $6,
         comments_enabled = COALESCE($7, comments_enabled),
         media_kind = $8,
         media_name = $9,
         media_content_type = $10,
         media_byte_size = $11,
         media_storage_key = $12,
         media_youtube_url = $13,
         updated_at = NOW()
       WHERE id = $1 AND server_id = $2`,
      [
        postId,
        serverId,
        title,
        body,
        teaser,
        visibility,
        input.commentsEnabled ?? null,
        media.media_kind,
        media.media_name,
        media.media_content_type,
        media.media_byte_size,
        media.media_storage_key,
        media.media_youtube_url,
      ],
    );
    await client.query("COMMIT");
    // Only after COMMIT: a rolled-back edit must not have deleted the object
    // the row still points at.
    if (
      previousKey &&
      previousKey !== media.media_storage_key &&
      isStorageConfigured()
    ) {
      await client.query(
        `DELETE FROM community_home_media_uploads WHERE storage_key = $1`,
        [previousKey],
      );
      try {
        await deleteObject(previousKey);
      } catch (error) {
        console.error(
          "[community-home] failed to delete replaced media object:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    return getCommunityHomePost(serverId, postId, actorId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function publishCommunityHomePost(
  serverId: string,
  postId: string,
  actorId: string,
): Promise<CommunityHomePost> {
  const canManage = await memberHasPermission(
    serverId,
    actorId,
    Permission.MANAGE_SERVER,
  );
  if (!canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }
  const pool = getPool();
  const existing = await pool.query<PostRow>(
    `SELECT ${postSelectSql("$1")} WHERE p.server_id = $2 AND p.id = $3`,
    [actorId, serverId, postId],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new CommunityHomeError("not_found", "Post not found");
  }
  assertPublishable({
    title: row.title,
    body: row.body,
    media: {
      media_kind: row.media_kind,
      media_name: row.media_name,
      media_content_type: row.media_content_type,
      media_byte_size: row.media_byte_size ? Number(row.media_byte_size) : null,
      media_storage_key: row.media_storage_key,
      media_youtube_url: row.media_youtube_url,
    },
    status: "published",
  });
  await pool.query(
    `UPDATE community_home_posts SET
       status = 'published',
       published_at = COALESCE(published_at, NOW()),
       scheduled_at = NULL,
       schedule_timezone = NULL,
       updated_at = NOW()
     WHERE id = $1 AND server_id = $2`,
    [postId, serverId],
  );
  return getCommunityHomePost(serverId, postId, actorId);
}

export async function unpublishCommunityHomePost(
  serverId: string,
  postId: string,
  actorId: string,
): Promise<CommunityHomePost> {
  const canManage = await memberHasPermission(
    serverId,
    actorId,
    Permission.MANAGE_SERVER,
  );
  if (!canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }
  const result = await getPool().query(
    `UPDATE community_home_posts SET
       status = 'draft',
       published_at = NULL,
       scheduled_at = NULL,
       schedule_timezone = NULL,
       updated_at = NOW()
     WHERE id = $1 AND server_id = $2
     RETURNING id`,
    [postId, serverId],
  );
  if (!result.rows[0]) {
    throw new CommunityHomeError("not_found", "Post not found");
  }
  return getCommunityHomePost(serverId, postId, actorId);
}

export async function scheduleCommunityHomePost(
  serverId: string,
  postId: string,
  actorId: string,
  scheduledAt: string,
  scheduleTimezone: string,
): Promise<CommunityHomePost> {
  const canManage = await memberHasPermission(
    serverId,
    actorId,
    Permission.MANAGE_SERVER,
  );
  if (!canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }
  if (new Date(scheduledAt).getTime() <= Date.now()) {
    throw new CommunityHomeError(
      "invalid",
      "Schedule time must be in the future",
    );
  }
  const pool = getPool();
  const existing = await pool.query<PostRow>(
    `SELECT ${postSelectSql("$1")} WHERE p.server_id = $2 AND p.id = $3`,
    [actorId, serverId, postId],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new CommunityHomeError("not_found", "Post not found");
  }
  assertPublishable({
    title: row.title,
    body: row.body,
    media: {
      media_kind: row.media_kind,
      media_name: row.media_name,
      media_content_type: row.media_content_type,
      media_byte_size: row.media_byte_size ? Number(row.media_byte_size) : null,
      media_storage_key: row.media_storage_key,
      media_youtube_url: row.media_youtube_url,
    },
    status: "scheduled",
  });
  await pool.query(
    `UPDATE community_home_posts SET
       status = 'scheduled',
       scheduled_at = $3,
       schedule_timezone = $4,
       published_at = NULL,
       updated_at = NOW()
     WHERE id = $1 AND server_id = $2`,
    [postId, serverId, scheduledAt, scheduleTimezone],
  );
  return getCommunityHomePost(serverId, postId, actorId);
}

export async function deleteCommunityHomePost(
  serverId: string,
  postId: string,
  actorId: string,
): Promise<void> {
  const canManage = await memberHasPermission(
    serverId,
    actorId,
    Permission.MANAGE_SERVER,
  );
  if (!canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }
  const result = await getPool().query<{ media_storage_key: string | null }>(
    `DELETE FROM community_home_posts
      WHERE id = $1 AND server_id = $2
      RETURNING media_storage_key`,
    [postId, serverId],
  );
  if (!result.rows[0]) {
    throw new CommunityHomeError("not_found", "Post not found");
  }
  const key = result.rows[0].media_storage_key;
  // The FK only nulls `claimed_post_id`, and the orphan sweep skips verified
  // rows, so without this the upload row would outlive its post forever.
  if (key) {
    await getPool().query(
      `DELETE FROM community_home_media_uploads WHERE storage_key = $1`,
      [key],
    );
  }
  if (key && isStorageConfigured()) {
    try {
      await deleteObject(key);
    } catch (error) {
      console.error(
        "[community-home] failed to delete media object:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export async function listCommunityHomeComments(
  serverId: string,
  postId: string,
  viewerId: string,
): Promise<CommunityHomeComment[]> {
  // Ensures the viewer may see the post (and that it exists).
  const post = await getCommunityHomePost(serverId, postId, viewerId);
  if (!post.commentsEnabled && !(await resolveHomeViewerCaps(serverId, viewerId)).canManage) {
    return [];
  }
  // The newest page, read oldest-first: a thread that outgrows the page is
  // one whose beginning nobody is scrolling to anyway.
  const result = await getPool().query<CommentRow>(
    `SELECT * FROM (
       SELECT c.id, c.body, c.created_at, c.author_id,
              u.display_name, u.username, u.discriminator, u.avatar_url
         FROM community_home_comments c
         JOIN users u ON u.id = c.author_id
        WHERE c.post_id = $1 ${notBlockedSql("$2")}
        ORDER BY c.created_at DESC
        LIMIT $3
     ) recent
     ORDER BY created_at ASC`,
    [postId, viewerId, COMMUNITY_HOME_COMMENTS_LIMIT],
  );
  return result.rows.map(toComment);
}

export async function addCommunityHomeComment(
  serverId: string,
  postId: string,
  authorId: string,
  body: string,
): Promise<CommunityHomeComment> {
  const post = await getCommunityHomePost(serverId, postId, authorId);
  if (post.status !== "published") {
    throw new CommunityHomeError("forbidden", "Comments only on published posts");
  }
  if (!post.commentsEnabled) {
    throw new CommunityHomeError("forbidden", "Comments are off on this post");
  }
  const result = await getPool().query<CommentRow>(
    `WITH inserted AS (
       INSERT INTO community_home_comments (post_id, author_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, created_at, author_id
     )
     SELECT i.id, i.body, i.created_at, i.author_id,
            u.display_name, u.username, u.discriminator, u.avatar_url
       FROM inserted i
       JOIN users u ON u.id = i.author_id`,
    [postId, authorId, body],
  );
  return toComment(result.rows[0]!);
}

export async function deleteCommunityHomeComment(
  serverId: string,
  postId: string,
  commentId: string,
  actorId: string,
): Promise<void> {
  const caps = await resolveHomeViewerCaps(serverId, actorId);
  const result = await getPool().query<{ author_id: string }>(
    `SELECT c.author_id
       FROM community_home_comments c
       JOIN community_home_posts p ON p.id = c.post_id
      WHERE c.id = $1 AND c.post_id = $2 AND p.server_id = $3`,
    [commentId, postId, serverId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CommunityHomeError("not_found", "Comment not found");
  }
  if (row.author_id !== actorId && !caps.canManage) {
    throw new CommunityHomeError("forbidden", "Cannot delete that comment");
  }
  await getPool().query(
    `DELETE FROM community_home_comments WHERE id = $1`,
    [commentId],
  );
}

export async function toggleCommunityHomeLike(
  serverId: string,
  postId: string,
  userId: string,
): Promise<{ liked: boolean; likeCount: number }> {
  const post = await getCommunityHomePost(serverId, postId, userId);
  if (post.status !== "published") {
    throw new CommunityHomeError("forbidden", "Likes only on published posts");
  }
  const pool = getPool();
  const existing = await pool.query(
    `SELECT 1 FROM community_home_likes WHERE post_id = $1 AND user_id = $2`,
    [postId, userId],
  );
  if (existing.rows[0]) {
    await pool.query(
      `DELETE FROM community_home_likes WHERE post_id = $1 AND user_id = $2`,
      [postId, userId],
    );
  } else {
    await pool.query(
      `INSERT INTO community_home_likes (post_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [postId, userId],
    );
  }
  const count = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM community_home_likes WHERE post_id = $1`,
    [postId],
  );
  const liked = !existing.rows[0];
  return { liked, likeCount: Number(count.rows[0]?.n ?? 0) };
}

// ------------------------------------------------------------------ media

function homeMediaPrefix(serverId: string): string {
  return `community-home/${serverId}/`;
}

export function communityHomeObjectKey(
  serverId: string,
  contentType: CommunityHomeContentType,
): string {
  return `${homeMediaPrefix(serverId)}${randomUUID()}${EXTENSION_BY_CONTENT_TYPE[contentType]}`;
}

export function isCommunityHomeKey(serverId: string, key: string): boolean {
  const prefix = homeMediaPrefix(serverId);
  return (
    key.startsWith(prefix) && !key.includes("..") && key.length > prefix.length
  );
}

export async function mintCommunityHomeMediaUpload(input: {
  serverId: string;
  uploaderId: string;
  contentType: CommunityHomeContentType;
  byteSize: number;
  filename: string;
}): Promise<{
  uploadId: string;
  key: string;
  uploadUrl: string;
  expiresAt: string;
  kind: "image" | "video" | "file";
}> {
  if (!isStorageConfigured()) {
    throw new CommunityHomeError(
      "storage_off",
      "Media uploads are not configured",
    );
  }
  if (input.byteSize > COMMUNITY_HOME_MAX_BYTES) {
    throw new CommunityHomeError("over_limit", "File too large");
  }
  const canManage = await memberHasPermission(
    input.serverId,
    input.uploaderId,
    Permission.MANAGE_SERVER,
  );
  if (!canManage) {
    throw new CommunityHomeError("forbidden", "Staff only");
  }
  const kind = communityHomeMediaKindFromContentType(input.contentType);
  const key = communityHomeObjectKey(input.serverId, input.contentType);
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO community_home_media_uploads (
       server_id, uploader_id, storage_key, filename, content_type, byte_size, kind
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.serverId,
      input.uploaderId,
      key,
      input.filename,
      input.contentType,
      input.byteSize,
      kind,
    ],
  );
  return {
    uploadId: result.rows[0]!.id,
    key,
    uploadUrl: presignPut(
      key,
      input.contentType,
      input.byteSize,
      UPLOAD_URL_TTL_SECONDS,
    ),
    expiresAt: new Date(
      Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
    ).toISOString(),
    kind,
  };
}

export async function claimCommunityHomeMediaUpload(input: {
  serverId: string;
  uploaderId: string;
  uploadId: string;
}): Promise<{
  uploadId: string;
  kind: "image" | "video" | "file";
  name: string;
  contentType: CommunityHomeContentType;
  byteSize: number;
}> {
  if (!isStorageConfigured()) {
    throw new CommunityHomeError(
      "storage_off",
      "Media uploads are not configured",
    );
  }
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    storage_key: string;
    filename: string;
    content_type: string;
    byte_size: string;
    kind: "image" | "video" | "file";
    uploader_id: string;
    server_id: string;
  }>(
    `SELECT id, storage_key, filename, content_type, byte_size, kind,
            uploader_id, server_id
       FROM community_home_media_uploads
      WHERE id = $1`,
    [input.uploadId],
  );
  const upload = result.rows[0];
  if (
    !upload ||
    upload.server_id !== input.serverId ||
    upload.uploader_id !== input.uploaderId
  ) {
    throw new CommunityHomeError("not_found", "Media upload not found");
  }
  if (!isCommunityHomeKey(input.serverId, upload.storage_key)) {
    throw new CommunityHomeError("invalid", "Invalid storage key");
  }
  let head;
  try {
    head = await headObject(upload.storage_key);
  } catch (error) {
    console.error(
      `[community-home] HEAD failed for ${upload.storage_key}:`,
      error instanceof Error ? error.message : error,
    );
    throw new CommunityHomeError("not_verified", "Upload could not be verified");
  }
  if (!head || head.contentLength <= 0) {
    throw new CommunityHomeError("not_verified", "Upload missing");
  }
  if (head.contentLength > COMMUNITY_HOME_MAX_BYTES) {
    throw new CommunityHomeError("over_limit", "File too large");
  }
  if (head.contentType !== upload.content_type) {
    throw new CommunityHomeError("not_verified", "Content type mismatch");
  }
  await pool.query(
    `UPDATE community_home_media_uploads
        SET verified_at = NOW(), byte_size = $2
      WHERE id = $1`,
    [upload.id, head.contentLength],
  );
  return {
    uploadId: upload.id,
    kind: upload.kind,
    name: upload.filename,
    contentType: upload.content_type as CommunityHomeContentType,
    byteSize: head.contentLength,
  };
}

/**
 * Publish every scheduled post whose time has arrived. Returns the server ids
 * that got at least one newly published post (for WS fanout).
 */
export async function publishDueCommunityHomePosts(): Promise<string[]> {
  const result = await getPool().query<{ server_id: string }>(
    `UPDATE community_home_posts
        SET status = 'published',
            published_at = NOW(),
            updated_at = NOW()
      WHERE status = 'scheduled'
        AND scheduled_at IS NOT NULL
        AND scheduled_at <= NOW()
      RETURNING server_id`,
  );
  return [...new Set(result.rows.map((r) => r.server_id))];
}

export async function sweepOrphanedCommunityHomeMedia(): Promise<number> {
  if (!isStorageConfigured()) {
    return 0;
  }
  const result = await getPool().query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM community_home_media_uploads
      WHERE claimed_post_id IS NULL
        AND verified_at IS NULL
        AND created_at < NOW() - $1::interval
      ORDER BY created_at ASC
      LIMIT $2`,
    [ORPHAN_GRACE, SWEEP_BATCH],
  );
  let deleted = 0;
  for (const row of result.rows) {
    try {
      await deleteObject(row.storage_key);
    } catch {
      // Still drop the row — an unreachable object is not worth keeping.
    }
    await getPool().query(
      `DELETE FROM community_home_media_uploads WHERE id = $1`,
      [row.id],
    );
    deleted += 1;
  }
  return deleted;
}

/** Re-export for WS notify helpers. */
export { listServerMemberIds };

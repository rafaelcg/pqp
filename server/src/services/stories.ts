import { randomUUID } from "node:crypto";
import {
  MESH_VOICE_LIMIT,
  Permission,
  computePermissions,
  parsePermissions,
  STORY_COMMUNITY_MIN_ACCOUNT_AGE_HOURS,
  STORY_IDS_MAX,
  STORY_MAX_BYTES,
  STORY_MAX_VIDEO_MS,
  STORY_POSTS_PER_DAY,
  STORY_SNIFF_BYTES,
  STORY_STRIP_MAX_AUTHORS,
  STORY_TTL_HOURS,
  STORY_VIEWERS_PAGE_SIZE,
  hasPermission,
  isStoryImageType,
  sniffStoryMediaType,
  type CreateStoryRequest,
  type StoriesConfig,
  type Story,
  type StoryAudience,
  type StoryAudienceBlockedReason,
  type StoryAudienceOptions,
  type StoryAuthor,
  type StoryBackground,
  type StoryCallLive,
  type StoryCard,
  type StoryContentType,
  type StoryKind,
  type StoryNotice,
  type StoryReaction,
  type StoryReplyBlockedReason,
  type StorySticker,
  type StoryStrip,
  type StoryStripItem,
  type StoryUpload,
  type StoryViewersPage,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool, type DbUser } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import {
  getObjectPrefix,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";
import { isFfmpegAvailable } from "../speech/transcode.js";
import { checkAutomod } from "./automod.js";
import { noBlockBetweenSql } from "./blocks.js";
import {
  isContentScanConfigured,
  quarantineDays,
  scanAllowsAttachment,
  scanImage,
  SCAN_URL_TTL_SECONDS,
  type ScanResult,
} from "./content-scan.js";
import { areFriendsSql } from "./friends.js";
import { computeMemberPermissions } from "./permissions.js";
import { createAutomatedStoryReport } from "./reports.js";
import { bumpStoryStat } from "./story-metrics.js";

/**
 * STORIES, the server side. `packages/shared/src/stories.ts` is the contract;
 * this file is the rules behind it.
 *
 * Visibility is decided here and nowhere else, in one place per question:
 *
 * - A SERVER audience is visible to a member of that server, while the
 *   `stories` flag is on for it, the audience row has not been removed by a
 *   moderator, and the author is still a member.
 * - The FRIENDS audience is visible to an accepted friend, while
 *   `stories_friends` is on. Evaluated at read time, so unfriending removes
 *   access at once.
 * - A block in EITHER direction hides every story, every way. Stricter than
 *   Baú comments on purpose: somebody you blocked must not watch yours.
 * - Only `live` stories whose `expires_at` is still ahead are ever served to
 *   anybody but their author, so a sweep that runs late shows nothing.
 *
 * Bytes never pass through here: a presigned PUT up, a HEAD and a 12 byte
 * prefix at publish, presigned GETs down whose lifetime never outlives the
 * story. Nothing between BEGIN and COMMIT touches the network.
 */

export const STORY_UPLOAD_URL_TTL_SECONDS = 15 * 60;
/**
 * How many per-server (or per-sticker) lookups one request runs at once. The
 * lists are already capped (10 target servers, 20 stories a read), and the
 * audience sheet only lists servers with stories on; this keeps any of them
 * from turning one request into a burst on the pool.
 */
const PER_REQUEST_CONCURRENCY = 4;

/** `Promise.all` over `items`, at most `limit` in flight, results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A read URL never lives past an hour, nor past the story itself. */
export const STORY_READ_URL_MAX_TTL_SECONDS = 60 * 60;
/** How long the call sticker's faces may be. */
const CALL_FACES = 5;

// ------------------------------------------------------------------ flags

/** `stories`, per server. */
export function storiesOnForServer(serverId: string): boolean {
  return isEnabled("stories", { serverId });
}

/** `stories_friends`, global. */
export function storiesFriendsOn(): boolean {
  return isEnabled("stories_friends");
}

export class StoryError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid"
      | "storage_off"
      | "video_off"
      | "over_limit"
      | "budget"
      | "automod"
      | "not_verified"
      | "refused"
      | "dm_closed"
      | "replies_off",
    message: string,
  ) {
    super(message);
    this.name = "StoryError";
  }
}

// ------------------------------------------------------------------ keys

const EXTENSION: Record<StoryContentType, string> = {
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/png": ".png",
  "video/mp4": ".mp4",
};

function storyPrefix(authorId: string, storyId: string): string {
  return `stories/${authorId}/${storyId}/`;
}

export function storyMediaKey(
  authorId: string,
  storyId: string,
  contentType: StoryContentType,
): string {
  return `${storyPrefix(authorId, storyId)}${randomUUID()}${EXTENSION[contentType]}`;
}

export function storyPosterKey(authorId: string, storyId: string): string {
  return `${storyPrefix(authorId, storyId)}poster.jpg`;
}

/**
 * Whether `key` is one of this story's own objects. Beside
 * `isCommunityHomeKey` and for the same reason: a key minted for one feature
 * can never be claimed, read or deleted through another.
 */
export function isStoryKey(authorId: string, storyId: string, key: string): boolean {
  const prefix = storyPrefix(authorId, storyId);
  return key.startsWith(prefix) && !key.includes("..") && key.length > prefix.length;
}

function readUrlTtlSeconds(expiresAt: Date | null): number {
  if (!expiresAt) {
    return STORY_READ_URL_MAX_TTL_SECONDS;
  }
  const left = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return Math.max(1, Math.min(STORY_READ_URL_MAX_TTL_SECONDS, left));
}

// ------------------------------------------------------------------ config

let processorSeen: { at: number; value: boolean } | null = null;

/**
 * Whether some process can check a video's frames: ffmpeg here, or a stories
 * job elsewhere (the worker) that said so in the last two minutes. Cached for
 * 30 s; a config read must not be a query per request.
 */
export async function storyVideoProcessorAvailable(): Promise<boolean> {
  if (await isFfmpegAvailable()) {
    return true;
  }
  if (processorSeen && Date.now() - processorSeen.at < 30_000) {
    return processorSeen.value;
  }
  let value = false;
  try {
    const result = await getPool().query(
      `SELECT 1 FROM story_media_processors
        WHERE seen_at > now() - interval '2 minutes' LIMIT 1`,
    );
    value = (result.rowCount ?? 0) > 0;
  } catch {
    value = false;
  }
  processorSeen = { at: Date.now(), value };
  return value;
}

/** Tests only. */
export function resetStoryProcessorCacheForTests(): void {
  processorSeen = null;
}

/**
 * Video is refused, rather than posted unscanned or left waiting forever,
 * when a scanner is configured and nothing can sample frames.
 */
async function videoEnabled(): Promise<boolean> {
  if (!isStorageConfigured()) {
    return false;
  }
  return !isContentScanConfigured() || (await storyVideoProcessorAvailable());
}

export async function storiesConfig(serverId: string | null): Promise<StoriesConfig> {
  const mediaEnabled = isStorageConfigured();
  return {
    enabled: serverId ? storiesOnForServer(serverId) : isEnabled("stories"),
    friendsEnabled: storiesFriendsOn(),
    mediaEnabled,
    videoEnabled: mediaEnabled && (await videoEnabled()),
    maxVideoMs: STORY_MAX_VIDEO_MS,
    maxBytes: STORY_MAX_BYTES,
    ttlHours: STORY_TTL_HOURS,
  };
}

// ------------------------------------------------------------------ posting rights

interface PosterRow {
  id: string;
  created_at: Date;
  is_character: boolean | null;
}

async function loadPoster(userId: string): Promise<PosterRow | null> {
  const result = await getPool().query<PosterRow>(
    `SELECT id, created_at, is_character FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Why `poster` may not post to each of `serverIds` now, or null when they may,
 * in ONE query for all of them. Server level, so no channel overwrites: the
 * same assembly as `loadMemberPermissionContext` (owner, @everyone, held
 * roles, Administrator), plus the timeout and the listed-community age rule.
 * Not a member is reported separately (`"not_member"`) because the routes
 * answer that one 404, like every other server route a non-member probes.
 */
export async function postingBlockReasons(
  serverIds: string[],
  poster: PosterRow,
): Promise<Map<string, StoryAudienceBlockedReason | "not_member" | null>> {
  const out = new Map<string, StoryAudienceBlockedReason | "not_member" | null>();
  if (serverIds.length === 0) {
    return out;
  }
  const rows = await getPool().query<{
    id: string;
    member: boolean;
    is_owner: boolean;
    listed: boolean;
    everyone: string | null;
    held: string[];
    timed_out: boolean;
  }>(
    `SELECT s.id,
            EXISTS (SELECT 1 FROM server_members m
                     WHERE m.server_id = s.id AND m.user_id = $1) AS member,
            s.owner_id = $1 AS is_owner,
            s.is_community_listed AS listed,
            (SELECT r.permissions::text FROM roles r
              WHERE r.server_id = s.id AND r.is_everyone LIMIT 1) AS everyone,
            ARRAY(SELECT r.permissions::text FROM member_roles mr
                    JOIN roles r ON r.id = mr.role_id AND r.server_id = mr.server_id
                   WHERE mr.server_id = s.id AND mr.user_id = $1) AS held,
            EXISTS (SELECT 1 FROM member_timeouts t
                     WHERE t.server_id = s.id AND t.user_id = $1
                       AND t.expires_at > now()) AS timed_out
       FROM servers s WHERE s.id = ANY($2::uuid[])`,
    [poster.id, serverIds],
  );
  const tooNew =
    Date.now() - poster.created_at.getTime() <
    STORY_COMMUNITY_MIN_ACCOUNT_AGE_HOURS * 60 * 60 * 1000;
  for (const serverId of serverIds) {
    const row = rows.rows.find((candidate) => candidate.id === serverId);
    if (!row || !row.member) {
      out.set(serverId, "not_member");
      continue;
    }
    const perms = computePermissions({
      isOwner: row.is_owner,
      everyonePermissions: parsePermissions(row.everyone ?? "0"),
      rolePermissions: row.held.map((bits) => parsePermissions(bits)),
      roleOverwrites: [],
    });
    out.set(
      serverId,
      !row.is_owner && row.timed_out
        ? "timed_out"
        : !hasPermission(perms, Permission.POST_STORIES)
          ? "no_permission"
          : !row.is_owner && row.listed && tooNew
            ? "account_too_new"
            : null,
    );
  }
  return out;
}

export async function postingBlockReason(
  serverId: string,
  poster: PosterRow,
): Promise<StoryAudienceBlockedReason | "not_member" | null> {
  const reasons = await postingBlockReasons([serverId], poster);
  // `null` is the answer "may post", so only a MISSING entry means not a member.
  return reasons.has(serverId) ? (reasons.get(serverId) ?? null) : "not_member";
}

/** What the composer's "Quem vê" sheet draws. */
export async function listStoryAudienceOptions(userId: string): Promise<StoryAudienceOptions> {
  const poster = await loadPoster(userId);
  const servers = await getPool().query<{
    id: string;
    name: string;
    icon_url: string | null;
    member_count: number;
  }>(
    `SELECT s.id, s.name, s.icon_url, s.member_count
       FROM server_members m JOIN servers s ON s.id = m.server_id
      WHERE m.user_id = $1
      ORDER BY m.joined_at ASC NULLS LAST, s.name ASC`,
    [userId],
  );
  const enabled = servers.rows.filter((row) => storiesOnForServer(row.id));
  const reasons =
    poster && !poster.is_character
      ? await postingBlockReasons(
          enabled.map((row) => row.id),
          poster,
        )
      : null;
  const out: StoryAudienceOptions["servers"] = enabled.map((row) => {
    const reason = !reasons
      ? ("no_permission" as const)
      : reasons.has(row.id)
        ? (reasons.get(row.id) ?? null)
        : ("not_member" as const);
    const blockedReason = reason === "not_member" ? "no_permission" : reason;
    return {
      serverId: row.id,
      serverName: row.name,
      iconUrl: row.icon_url,
      memberCount: row.member_count,
      canPost: blockedReason === null,
      blockedReason,
    };
  });
  const friendsEnabled = storiesFriendsOn();
  return {
    servers: out,
    friends: {
      enabled: friendsEnabled,
      canPost: friendsEnabled && Boolean(poster) && !poster?.is_character,
    },
  };
}

// ------------------------------------------------------------------ rows

interface StoryRow {
  id: string;
  author_id: string;
  kind: StoryKind;
  status: "pending" | "processing" | "live" | "expired" | "deleted";
  caption: string | null;
  text_body: string | null;
  background: string | null;
  sticker: StorySticker | null;
  replies_enabled: boolean;
  media_storage_key: string | null;
  media_content_type: string | null;
  media_byte_size: number | null;
  media_width: number | null;
  media_height: number | null;
  media_duration_ms: number | null;
  poster_storage_key: string | null;
  published_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  author_name: string;
  author_avatar: string | null;
  author_handle: string | null;
  author_dm_privacy: string;
}

const STORY_COLUMNS = `
  s.id, s.author_id, s.kind, s.status, s.caption, s.text_body, s.background,
  s.sticker, s.replies_enabled, s.media_storage_key, s.media_content_type,
  s.media_byte_size, s.media_width, s.media_height, s.media_duration_ms,
  s.poster_storage_key, s.published_at, s.expires_at, s.created_at,
  u.display_name AS author_name, u.avatar_url AS author_avatar,
  u.handle AS author_handle, u.dm_privacy AS author_dm_privacy`;

interface AudienceRow {
  story_id: string;
  server_id: string | null;
  server_name: string | null;
  removed_at: Date | null;
  viewer_member: boolean;
  author_member: boolean;
}

function authorOf(row: {
  author_id: string;
  author_name: string;
  author_avatar: string | null;
  author_handle: string | null;
}): StoryAuthor {
  return {
    id: row.author_id,
    displayName: row.author_name,
    avatarUrl: row.author_avatar,
    handle: row.author_handle,
  };
}

/**
 * The audiences of `storyIds` that `viewerId` sees them through, with the
 * flag decided here (it is an in-process snapshot, not a column). The author
 * sees every audience of their own story that a moderator has not removed.
 */
async function visibleAudiences(
  viewerId: string,
  rows: StoryRow[],
): Promise<Map<string, StoryAudience[]>> {
  const out = new Map<string, StoryAudience[]>();
  if (rows.length === 0) {
    return out;
  }
  const audiences = await getPool().query<AudienceRow>(
    `SELECT a.story_id, a.server_id, srv.name AS server_name, a.removed_at,
            (a.server_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM server_members m
                WHERE m.server_id = a.server_id AND m.user_id = $2
            )) AS viewer_member,
            (a.server_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM server_members m
                WHERE m.server_id = a.server_id AND m.user_id = s.author_id
            )) AS author_member
       FROM story_audiences a
       JOIN stories s ON s.id = a.story_id
       LEFT JOIN servers srv ON srv.id = a.server_id
      WHERE a.story_id = ANY($1::uuid[])
      ORDER BY a.server_id NULLS LAST`,
    [rows.map((row) => row.id), viewerId],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const friendsOf = await friendAuthors(
    viewerId,
    rows.filter((row) => row.author_id !== viewerId).map((row) => row.author_id),
  );
  const friendsOn = storiesFriendsOn();
  for (const audience of audiences.rows) {
    const story = byId.get(audience.story_id);
    if (!story || audience.removed_at) {
      continue;
    }
    const own = story.author_id === viewerId;
    let visible: StoryAudience | null = null;
    if (audience.server_id) {
      if (
        storiesOnForServer(audience.server_id) &&
        audience.author_member &&
        (own || audience.viewer_member)
      ) {
        visible = {
          kind: "server",
          serverId: audience.server_id,
          serverName: audience.server_name ?? "",
        };
      }
    } else if (friendsOn && (own || friendsOf.has(story.author_id))) {
      visible = { kind: "friends" };
    }
    if (visible) {
      const list = out.get(story.id) ?? [];
      list.push(visible);
      out.set(story.id, list);
    }
  }
  return out;
}

async function friendAuthors(viewerId: string, authorIds: string[]): Promise<Set<string>> {
  if (authorIds.length === 0) {
    return new Set();
  }
  const result = await getPool().query<{ id: string }>(
    `SELECT a.id FROM unnest($2::uuid[]) AS a(id)
      WHERE ${areFriendsSql("a.id", "$1::uuid")}`,
    [viewerId, [...new Set(authorIds)]],
  );
  return new Set(result.rows.map((row) => row.id));
}

/**
 * Stories by id that the viewer may see right now, as rows plus the audiences
 * they see each through. The one gate every per-story route goes through.
 * Includes the viewer's own stories in any state but `expired` and `deleted`.
 */
async function loadVisible(
  viewerId: string,
  ids: string[],
): Promise<{ rows: StoryRow[]; audiences: Map<string, StoryAudience[]> }> {
  if (ids.length === 0) {
    return { rows: [], audiences: new Map() };
  }
  const result = await getPool().query<StoryRow>(
    `SELECT ${STORY_COLUMNS}
       FROM stories s JOIN users u ON u.id = s.author_id
      WHERE s.id = ANY($1::uuid[])
        AND (
          (s.status = 'live' AND s.expires_at > now()
             AND ${noBlockBetweenSql("s.author_id", "$2::uuid")})
          OR (s.author_id = $2::uuid AND s.status IN ('pending', 'processing'))
          OR (s.author_id = $2::uuid AND s.status = 'live' AND s.expires_at > now())
        )`,
    [[...new Set(ids)], viewerId],
  );
  const audiences = await visibleAudiences(viewerId, result.rows);
  const rows = result.rows.filter(
    (row) => row.author_id === viewerId || (audiences.get(row.id)?.length ?? 0) > 0,
  );
  return { rows, audiences };
}

/** One story the viewer may see, or a `not_found` StoryError. */
async function requireVisible(
  viewerId: string,
  storyId: string,
): Promise<{ row: StoryRow; audiences: StoryAudience[] }> {
  const { rows, audiences } = await loadVisible(viewerId, [storyId]);
  const row = rows[0];
  if (!row) {
    throw new StoryError("not_found", "Story not found");
  }
  return { row, audiences: audiences.get(row.id) ?? [] };
}

// ------------------------------------------------------------------ hydrate

interface ViewRow {
  story_id: string;
  reaction: StoryReaction | null;
}

async function viewerViews(viewerId: string, ids: string[]): Promise<Map<string, ViewRow>> {
  if (ids.length === 0) {
    return new Map();
  }
  const result = await getPool().query<ViewRow>(
    `SELECT story_id, reaction FROM story_views
      WHERE viewer_id = $1 AND story_id = ANY($2::uuid[])`,
    [viewerId, ids],
  );
  return new Map(result.rows.map((row) => [row.story_id, row]));
}

async function ownCounts(
  ids: string[],
): Promise<Map<string, { views: number; reactions: number; replies: number }>> {
  if (ids.length === 0) {
    return new Map();
  }
  // Kept by the `trg_story_view_counts` trigger on `story_views`: a read
  // never recounts a story's whole audience.
  const result = await getPool().query<{
    id: string;
    view_count: number;
    reaction_count: number;
    reply_count: number;
  }>(
    `SELECT id, view_count, reaction_count, reply_count
       FROM stories WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      { views: row.view_count, reactions: row.reaction_count, replies: row.reply_count },
    ]),
  );
}

/**
 * Whether the viewer may reply to each author: the author's DM privacy, read
 * the way `assertReachable` in services/dms.ts reads it (blocks are already
 * excluded upstream: a blocked pair never sees the story at all).
 */
async function replyReachability(
  viewerId: string,
  authorIds: string[],
): Promise<Map<string, boolean>> {
  if (authorIds.length === 0) {
    return new Map();
  }
  const result = await getPool().query<{ id: string; reachable: boolean }>(
    `SELECT u.id,
            CASE u.dm_privacy
              WHEN 'nobody' THEN FALSE
              WHEN 'server_members' THEN (
                EXISTS (
                  SELECT 1 FROM server_members mine
                  JOIN server_members theirs
                    ON theirs.server_id = mine.server_id AND theirs.user_id = u.id
                  WHERE mine.user_id = $1
                ) OR ${areFriendsSql("u.id", "$1::uuid")}
              )
              WHEN 'everyone' THEN TRUE
              ELSE FALSE
            END AS reachable
       FROM users u WHERE u.id = ANY($2::uuid[])`,
    [viewerId, [...new Set(authorIds)]],
  );
  return new Map(result.rows.map((row) => [row.id, row.reachable]));
}

/** Server-level bits per server, resolved once each and concurrently. */
async function serverPermissions(
  userId: string,
  serverIds: string[],
): Promise<Map<string, bigint>> {
  const entries = await mapLimit(
    serverIds,
    PER_REQUEST_CONCURRENCY,
    async (serverId) => [serverId, await computeMemberPermissions(serverId, userId)] as const,
  );
  return new Map(entries);
}

interface CallRoom {
  serverId: string;
  channelId: string;
  name: string;
  viewerCanSee: boolean;
  viewerCanJoin: boolean;
  seated: string[];
  transport: "mesh" | "livekit";
}

/**
 * The call stickers of a read, as they are now: who is in each room, read
 * from the voice roster (cluster-wide with the registry on). One query for
 * every sticker's channel and one for every face, and one roster read and one
 * permission check per DISTINCT room, so ten stories pointing at the Lobby
 * cost one. The roster is the channel's, so the channel's rule decides who
 * sees it: a viewer without VIEW_CHANNEL and CONNECT there gets the sticker
 * with no faces, no count and no join button. The voice module is imported
 * lazily; a read with no call never loads it.
 */
async function resolveCalls(
  viewerId: string,
  rows: StoryRow[],
): Promise<Map<string, StoryCallLive>> {
  const out = new Map<string, StoryCallLive>();
  const stickered = rows.filter(
    (row): row is StoryRow & { sticker: StorySticker } => row.sticker?.type === "call",
  );
  if (stickered.length === 0) {
    return out;
  }
  const channelIds = [...new Set(stickered.map((row) => row.sticker.channelId))];
  const channels = await getPool().query<{ id: string; name: string; server_id: string }>(
    `SELECT id, name, server_id FROM channels WHERE id = ANY($1::uuid[])`,
    [channelIds],
  );
  let voice: typeof import("../ws/voice.js") | null = null;
  try {
    voice = await import("../ws/voice.js");
  } catch (error) {
    console.error("[stories] voice module unavailable:", error instanceof Error ? error.message : error);
  }
  const rooms = new Map<string, CallRoom>(
    await mapLimit(channels.rows, PER_REQUEST_CONCURRENCY, async (channel) => {
      const perms = await computeMemberPermissions(channel.server_id, viewerId, channel.id);
      const viewerCanSee = hasPermission(perms, Permission.VIEW_CHANNEL);
      const viewerCanJoin = viewerCanSee && hasPermission(perms, Permission.CONNECT);
      let seated: string[] = [];
      let transport: "mesh" | "livekit" = "livekit";
      if (viewerCanJoin && voice) {
        try {
          seated = [...new Set((await voice.musicRoomSeats(channel.id)).seatedUserIds)];
          transport = voice.getRoomTransport(channel.id);
        } catch (error) {
          console.error(
            "[stories] call roster read failed:",
            error instanceof Error ? error.message : error,
          );
        }
      }
      return [
        channel.id,
        {
          serverId: channel.server_id,
          channelId: channel.id,
          name: channel.name,
          viewerCanSee,
          viewerCanJoin,
          seated,
          transport,
        },
      ] as const;
    }),
  );
  const faces = (room: CallRoom, authorId: string) =>
    [
      ...room.seated.filter((id) => id === authorId),
      ...room.seated.filter((id) => id !== authorId),
    ].slice(0, CALL_FACES);
  const everyone = [
    ...new Set(
      stickered.flatMap((row) => {
        const room = rooms.get(row.sticker.channelId);
        return room ? faces(room, row.author_id) : [];
      }),
    ),
  ];
  const people = everyone.length
    ? await getPool().query<{
        id: string;
        display_name: string;
        avatar_url: string | null;
        handle: string | null;
      }>(
        `SELECT id, display_name, avatar_url, handle FROM users WHERE id = ANY($1::uuid[])`,
        [everyone],
      )
    : { rows: [] };
  const byId = new Map(people.rows.map((person) => [person.id, person]));
  for (const row of stickered) {
    const room = rooms.get(row.sticker.channelId);
    // A room the viewer cannot see is not named to them at all: no call.
    if (!room || room.serverId !== row.sticker.serverId || !room.viewerCanSee) {
      continue;
    }
    if (!room.viewerCanJoin) {
      out.set(row.id, {
        serverId: room.serverId,
        channelId: room.channelId,
        channelName: room.name,
        participants: [],
        count: 0,
        state: "ended",
        joinable: false,
      });
      continue;
    }
    const live = room.seated.includes(row.author_id);
    const full = live && room.transport === "mesh" && room.seated.length >= MESH_VOICE_LIMIT;
    const state: StoryCallLive["state"] = !live ? "ended" : full ? "full" : "live";
    out.set(row.id, {
      serverId: room.serverId,
      channelId: room.channelId,
      channelName: room.name,
      participants: faces(room, row.author_id).flatMap((id) => {
        const person = byId.get(id);
        return person
          ? [
              {
                id: person.id,
                displayName: person.display_name,
                avatarUrl: person.avatar_url,
                handle: person.handle,
              },
            ]
          : [];
      }),
      count: room.seated.length,
      state,
      joinable: state === "live",
    });
  }
  return out;
}

function mediaOf(row: StoryRow): Story["media"] {
  if (!row.media_storage_key || !row.media_content_type) {
    return null;
  }
  const ttlSeconds = readUrlTtlSeconds(row.expires_at);
  return {
    url: presignGet(row.media_storage_key, { ttlSeconds }),
    posterUrl: row.poster_storage_key
      ? presignGet(row.poster_storage_key, { ttlSeconds })
      : null,
    contentType: row.media_content_type as StoryContentType,
    width: row.media_width ?? 1,
    height: row.media_height ?? 1,
    durationMs: row.media_duration_ms,
  };
}

/**
 * Rows to wire stories, for one viewer. `audiences` is what this viewer sees
 * each through (the author: all of them).
 */
async function hydrate(
  viewerId: string,
  rows: StoryRow[],
  audiences: Map<string, StoryAudience[]>,
): Promise<Story[]> {
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);
  const others = rows.filter((row) => row.author_id !== viewerId);
  const own = rows.filter((row) => row.author_id === viewerId);
  const [views, counts, reach] = await Promise.all([
    viewerViews(viewerId, ids),
    ownCounts(own.map((row) => row.id)),
    replyReachability(
      viewerId,
      others.map((row) => row.author_id),
    ),
  ]);
  const serverIdsSeen = new Set<string>();
  for (const list of audiences.values()) {
    for (const audience of list) {
      if (audience.kind === "server") {
        serverIdsSeen.add(audience.serverId);
      }
    }
  }
  const perms = await serverPermissions(viewerId, [...serverIdsSeen]);
  const holds = (serverId: string, bit: bigint) => hasPermission(perms.get(serverId) ?? 0n, bit);
  const bauOn = own.length > 0 && isEnabled("community_home");
  // Call stickers resolved together rather than one after another.
  const calls = await resolveCalls(viewerId, rows);

  const stories: Story[] = [];
  for (const row of rows) {
    const seenThrough = audiences.get(row.id) ?? [];
    const serverAudienceIds = seenThrough.flatMap((audience) =>
      audience.kind === "server" ? [audience.serverId] : [],
    );
    const isOwn = row.author_id === viewerId;
    const view = views.get(row.id);
    let canReply = false;
    let replyBlockedReason: StoryReplyBlockedReason | null = null;
    if (!isOwn) {
      if (!row.replies_enabled) {
        replyBlockedReason = "replies_off";
      } else if (!reach.get(row.author_id)) {
        replyBlockedReason = "dm_closed";
      } else {
        canReply = true;
      }
    }
    const call =
      row.sticker?.type === "call" && serverAudienceIds.includes(row.sticker.serverId)
        ? (calls.get(row.id) ?? null)
        : null;
    const count = counts.get(row.id);
    stories.push({
      id: row.id,
      author: authorOf(row),
      kind: row.kind,
      caption: row.caption,
      text: row.text_body,
      background: (row.background as StoryBackground | null) ?? null,
      media: mediaOf(row),
      sticker: row.sticker,
      call,
      publishedAt: row.published_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      audiences: seenThrough,
      viewer: {
        seen: Boolean(view),
        reaction: view?.reaction ?? null,
        canReply,
        replyBlockedReason,
        canModerate: serverAudienceIds.filter((id) => holds(id, Permission.MANAGE_MESSAGES)),
        canSaveToBau:
          isOwn && bauOn
            ? serverAudienceIds.filter((id) => holds(id, Permission.MANAGE_SERVER))
            : [],
      },
      own: isOwn
        ? {
            status: row.status === "pending" || row.status === "processing" ? row.status : "live",
            viewCount: count?.views ?? 0,
            reactionCount: count?.reactions ?? 0,
            replyCount: count?.replies ?? 0,
            repliesEnabled: row.replies_enabled,
          }
        : null,
    });
  }
  return stories;
}

/** `GET /api/stories?ids=`: what the viewer may see, in the order asked. */
export async function getStoriesForViewer(viewerId: string, ids: string[]): Promise<Story[]> {
  const unique = [...new Set(ids)].slice(0, STORY_IDS_MAX);
  const { rows, audiences } = await loadVisible(viewerId, unique);
  const stories = await hydrate(viewerId, rows, audiences);
  const order = new Map(unique.map((id, index) => [id, index]));
  return stories.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function getStoryForViewer(viewerId: string, storyId: string): Promise<Story> {
  const [story] = await getStoriesForViewer(viewerId, [storyId]);
  if (!story) {
    throw new StoryError("not_found", "Story not found");
  }
  return story;
}

// ------------------------------------------------------------------ strips

interface StripRow {
  author_id: string;
  story_ids: string[];
  latest_at: Date;
  expires_at: Date;
  unseen: boolean;
  has_call: boolean;
  author_name: string;
  author_avatar: string | null;
  author_handle: string | null;
}

function stripItem(row: StripRow): StoryStripItem {
  return {
    author: authorOf(row),
    storyIds: row.story_ids,
    latestAt: row.latest_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    unseen: row.unseen,
    hasCall: row.has_call,
  };
}

/**
 * One statement for the rings of one audience. `liveSql` selects the live
 * stories of the audience as `live(id, author_id, published_at, expires_at,
 * sticker)`, with the viewer as `$1`; this groups them per author, marks unseen, and
 * orders: the viewer's own row first, then unseen authors (friends, then DM
 * recency, then newest), then seen authors newest first.
 */
async function stripRows(
  liveSql: string,
  params: unknown[],
): Promise<StripRow[]> {
  const result = await getPool().query<StripRow>(
    `WITH live AS (${liveSql}),
     grouped AS (
       SELECT l.author_id,
              array_agg(l.id ORDER BY l.published_at ASC) AS story_ids,
              max(l.published_at) AS latest_at,
              max(l.expires_at) AS expires_at,
              bool_or(v.story_id IS NULL) AS unseen,
              bool_or(l.sticker->>'type' = 'call') AS has_call
         FROM live l
         LEFT JOIN story_views v ON v.story_id = l.id AND v.viewer_id = $1
        GROUP BY l.author_id
     )
     SELECT g.author_id, g.story_ids, g.latest_at, g.expires_at,
            (g.unseen AND g.author_id <> $1) AS unseen, g.has_call,
            u.display_name AS author_name, u.avatar_url AS author_avatar,
            u.handle AS author_handle
       FROM grouped g
       JOIN users u ON u.id = g.author_id
       LEFT JOIN dm_pairs p
         ON p.low_user_id = LEAST(g.author_id, $1::uuid)
        AND p.high_user_id = GREATEST(g.author_id, $1::uuid)
      ORDER BY (g.author_id = $1) DESC,
               g.unseen DESC,
               CASE WHEN g.unseen THEN ${areFriendsSql("g.author_id", "$1::uuid")} END DESC NULLS LAST,
               CASE WHEN g.unseen THEN (
                 SELECT m.created_at FROM messages m
                  WHERE m.channel_id = p.channel_id
                  ORDER BY m.created_at DESC LIMIT 1
               ) END DESC NULLS LAST,
               g.latest_at DESC
      LIMIT ${STORY_STRIP_MAX_AUTHORS + 1}`,
    params,
  );
  return result.rows;
}

/** The viewer is not blocked either way, and has not muted the author. */
function stripPeopleSql(authorExpr: string): string {
  return `(${authorExpr} = $1 OR (
            ${noBlockBetweenSql(authorExpr, "$1::uuid")}
            AND NOT EXISTS (
              SELECT 1 FROM story_mutes mu
               WHERE mu.user_id = $1 AND mu.muted_user_id = ${authorExpr}
            )))`;
}

function splitStrip(rows: StripRow[], viewerId: string): Pick<StoryStrip, "own" | "items"> {
  const own = rows.find((row) => row.author_id === viewerId) ?? null;
  return {
    own: own ? stripItem(own) : null,
    items: rows
      .filter((row) => row.author_id !== viewerId)
      .slice(0, STORY_STRIP_MAX_AUTHORS)
      .map(stripItem),
  };
}

const OFF_STRIP: StoryStrip = {
  enabled: false,
  canPost: false,
  own: null,
  items: [],
  firstRunHint: false,
};

/** `GET /api/servers/:serverId/stories`. The caller has checked membership. */
export async function listServerStrip(viewer: DbUser, serverId: string): Promise<StoryStrip> {
  if (!storiesOnForServer(serverId)) {
    return OFF_STRIP;
  }
  const rows = await stripRows(
    `SELECT s.id, s.author_id, s.published_at, s.expires_at, s.sticker
       FROM story_audiences a
       JOIN stories s ON s.id = a.story_id
      WHERE a.server_id = $2 AND a.removed_at IS NULL AND a.expires_at > now()
        AND s.status = 'live' AND s.expires_at > now()
        AND EXISTS (
          SELECT 1 FROM server_members am
           WHERE am.server_id = $2 AND am.user_id = s.author_id
        )
        AND ${stripPeopleSql("s.author_id")}`,
    [viewer.id, serverId],
  );
  const poster = await loadPoster(viewer.id);
  const blocked =
    !poster || poster.is_character ? "no_permission" : await postingBlockReason(serverId, poster);
  const strip = splitStrip(rows, viewer.id);
  return {
    enabled: true,
    canPost: blocked === null,
    ...strip,
    firstRunHint:
      strip.items.length === 0 && !strip.own && (await firstRunHint(viewer.id, serverId)),
  };
}

/**
 * The one-off dashed row: the flag went on for this server (or for
 * everybody) in the last 7 days, and this viewer has never posted here. The
 * dismissal is the client's to remember.
 */
async function firstRunHint(viewerId: string, serverId: string): Promise<boolean> {
  const result = await getPool().query<{ hint: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM feature_flag_overrides
          WHERE key = 'stories' AND server_id = $2 AND enabled
            AND updated_at > now() - interval '7 days'
       ) OR (
         NOT EXISTS (
           SELECT 1 FROM feature_flag_overrides WHERE key = 'stories' AND server_id = $2
         ) AND EXISTS (
           SELECT 1 FROM feature_flags
            WHERE key = 'stories' AND enabled
              AND updated_at > now() - interval '7 days'
         )
       )
     ) AND NOT EXISTS (
       SELECT 1 FROM story_audiences a JOIN stories s ON s.id = a.story_id
        WHERE a.server_id = $2 AND s.author_id = $1
     ) AS hint`,
    [viewerId, serverId],
  );
  return result.rows[0]?.hint ?? false;
}

/** `GET /api/stories/friends`. */
export async function listFriendsStrip(viewer: DbUser): Promise<StoryStrip> {
  if (!storiesFriendsOn()) {
    return OFF_STRIP;
  }
  const rows = await stripRows(
    `SELECT s.id, s.author_id, s.published_at, s.expires_at, s.sticker
       FROM story_audiences a
       JOIN stories s ON s.id = a.story_id
      WHERE a.server_id IS NULL AND a.removed_at IS NULL AND a.expires_at > now()
        AND s.status = 'live' AND s.expires_at > now()
        AND (s.author_id = $1 OR ${areFriendsSql("s.author_id", "$1::uuid")})
        AND ${stripPeopleSql("s.author_id")}`,
    [viewer.id],
  );
  const poster = await loadPoster(viewer.id);
  const strip = splitStrip(rows, viewer.id);
  return {
    enabled: true,
    canPost: Boolean(poster) && !poster?.is_character,
    ...strip,
    firstRunHint: false,
  };
}

// ------------------------------------------------------------------ create

export interface CreatedStory {
  story: Story;
  upload: StoryUpload | null;
  /** Server ids a live text story went to, for the WS nudge. */
  liveServerIds: string[];
  liveFriends: boolean;
}

async function assertCanPost(user: DbUser, input: CreateStoryRequest): Promise<PosterRow> {
  const poster = await loadPoster(user.id);
  if (!poster) {
    throw new StoryError("not_found", "Not found");
  }
  // Stories are what PEOPLE are up to. The house cast stays in chat.
  if (poster.is_character) {
    throw new StoryError("forbidden", "Characters do not post stories");
  }
  if (input.audiences.friends && !storiesFriendsOn()) {
    throw new StoryError("not_found", "Not found");
  }
  if (input.audiences.serverIds.some((serverId) => !storiesOnForServer(serverId))) {
    throw new StoryError("not_found", "Server not found");
  }
  const reasons = [...(await postingBlockReasons(input.audiences.serverIds, poster)).values()];
  if (reasons.includes("not_member")) {
    throw new StoryError("not_found", "Server not found");
  }
  const blocked = reasons.find((reason) => reason !== null);
  if (blocked) {
    throw new StoryError("forbidden", `You cannot post stories there (${blocked})`);
  }
  return poster;
}

async function assertSticker(userId: string, sticker: StorySticker | undefined): Promise<void> {
  if (!sticker) {
    return;
  }
  const channel = await getPool().query<{ server_id: string | null; type: string }>(
    `SELECT server_id, type FROM channels WHERE id = $1`,
    [sticker.channelId],
  );
  const row = channel.rows[0];
  if (!row || row.server_id !== sticker.serverId || row.type !== "voice") {
    throw new StoryError("invalid", "The call must be a voice channel of that server");
  }
  const perms = await computeMemberPermissions(sticker.serverId, userId, sticker.channelId);
  if (!hasPermission(perms, Permission.CONNECT)) {
    throw new StoryError("invalid", "You cannot join that call");
  }
}

/**
 * AutoMod reads a story's words the way it reads a message's, per target
 * server. A staff member exempt from AutoMod in chat is exempt here too.
 */
async function assertAutomod(userId: string, input: CreateStoryRequest): Promise<void> {
  const body = [input.text, input.caption].filter(Boolean).join("\n");
  if (!body) {
    return;
  }
  const verdicts = await mapLimit(input.audiences.serverIds, PER_REQUEST_CONCURRENCY, async (serverId) =>
    checkAutomod({
      serverId,
      channelId: "",
      authorId: userId,
      memberPerms: await computeMemberPermissions(serverId, userId),
      body,
    }),
  );
  const verdict = verdicts.find((entry) => entry !== null);
  if (verdict) {
    throw new StoryError("automod", verdict.customMessage ?? "This story was blocked by AutoMod");
  }
}

/**
 * Within budget: `STORY_POSTS_PER_DAY` per rolling 24 hours, counted in the
 * database so it is exact however many API processes run. Every minted story
 * counts, published or not, so minting is not a way around it.
 */
async function assertBudget(client: PoolClient, userId: string): Promise<void> {
  // Serialised per author, inside the insert's transaction: two creates at
  // once cannot both read a count under the cap and both insert.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('story-budget:' || $1::text))`, [
    userId,
  ]);
  const result = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM stories
      WHERE author_id = $1 AND created_at > now() - interval '24 hours'`,
    [userId],
  );
  if (Number(result.rows[0]?.n ?? 0) >= STORY_POSTS_PER_DAY) {
    throw new StoryError("budget", "Too many stories today");
  }
}

export async function createStory(user: DbUser, input: CreateStoryRequest): Promise<CreatedStory> {
  await assertCanPost(user, input);
  if (input.kind !== "text") {
    if (!isStorageConfigured()) {
      throw new StoryError("storage_off", "Media uploads are not configured");
    }
    if (input.kind === "video" && !(await videoEnabled())) {
      throw new StoryError("video_off", "Video stories are off here");
    }
  }
  await assertSticker(user.id, input.sticker);
  await assertAutomod(user.id, input);

  const storyId = randomUUID();
  const media = input.kind === "text" ? null : input.media!;
  const contentType = media?.contentType ?? null;
  const key = contentType ? storyMediaKey(user.id, storyId, contentType) : null;
  const live = input.kind === "text";

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertBudget(client, user.id);
    const inserted = await client.query<{ expires_at: Date | null }>(
      `INSERT INTO stories (
         id, author_id, kind, status, caption, text_body, background, sticker,
         replies_enabled, media_storage_key, media_content_type, media_byte_size,
         media_width, media_height, media_duration_ms, scan_status,
         published_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15,
         $16,
         CASE WHEN $17 THEN now() END,
         CASE WHEN $17 THEN now() + make_interval(hours => $18) END
       ) RETURNING expires_at`,
      [
        storyId,
        user.id,
        input.kind,
        live ? "live" : "pending",
        input.kind === "text" ? null : input.caption || null,
        input.kind === "text" ? input.text : null,
        input.kind === "text" ? input.background : null,
        input.sticker ? JSON.stringify(input.sticker) : null,
        input.repliesEnabled,
        key,
        contentType,
        media?.byteSize ?? null,
        media?.width ?? null,
        media?.height ?? null,
        media?.durationMs ?? null,
        // A text card is words, not an image: nothing for an image scanner.
        live ? "skipped" : "unscanned",
        live,
        STORY_TTL_HOURS,
      ],
    );
    const expiresAt = inserted.rows[0]?.expires_at ?? null;
    await insertAudiences(client, storyId, input, expiresAt);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let story: Story;
  try {
    story = await getStoryForViewer(user.id, storyId);
  } catch (error) {
    // Committed, but the author never got an answer: take it back, so a retry
    // is a clean second attempt rather than a duplicate (and a pending story
    // with no upload URL). Nothing was announced yet; the route does that.
    await getPool()
      .query(`DELETE FROM stories WHERE id = $1 AND author_id = $2`, [storyId, user.id])
      .catch(() => undefined);
    throw error;
  }
  if (live) {
    bumpStoryStat("published");
  }
  return {
    story,
    upload:
      key && media
        ? {
            url: presignPut(key, media.contentType, media.byteSize, STORY_UPLOAD_URL_TTL_SECONDS),
            method: "PUT",
            headers: { "Content-Type": media.contentType },
            expiresAt: new Date(
              Date.now() + STORY_UPLOAD_URL_TTL_SECONDS * 1000,
            ).toISOString(),
          }
        : null,
    liveServerIds: live ? input.audiences.serverIds : [],
    liveFriends: live && input.audiences.friends,
  };
}

async function insertAudiences(
  client: PoolClient,
  storyId: string,
  input: CreateStoryRequest,
  expiresAt: Date | null,
): Promise<void> {
  if (input.audiences.serverIds.length > 0) {
    await client.query(
      `INSERT INTO story_audiences (story_id, server_id, expires_at)
       SELECT $1, unnest($2::uuid[]), $3`,
      [storyId, input.audiences.serverIds, expiresAt],
    );
  }
  if (input.audiences.friends) {
    await client.query(
      `INSERT INTO story_audiences (story_id, server_id, expires_at) VALUES ($1, NULL, $2)`,
      [storyId, expiresAt],
    );
  }
}

// ------------------------------------------------------------------ publish

export interface AudienceTargets {
  serverIds: string[];
  friends: boolean;
}

/** Where a story is shown (not removed), for the WS nudge. */
export async function storyAudienceTargets(storyId: string): Promise<AudienceTargets> {
  const result = await getPool().query<{ server_id: string | null }>(
    `SELECT server_id FROM story_audiences WHERE story_id = $1 AND removed_at IS NULL`,
    [storyId],
  );
  return {
    serverIds: result.rows.flatMap((row) => (row.server_id ? [row.server_id] : [])),
    friends: result.rows.some((row) => row.server_id === null),
  };
}

/**
 * Flip a story live: `published_at` now, `expires_at` 24 hours on, copied to
 * its audiences in the same transaction. Only from pending or processing, so
 * two processes racing to publish the same story flip it once.
 */
export async function goLive(storyId: string, claim: string | null = null): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ expires_at: Date }>(
      `UPDATE stories
          SET status = 'live', published_at = now(),
              expires_at = now() + make_interval(hours => $2),
              processing_claimed_at = NULL
        WHERE id = $1 AND status IN ('pending', 'processing')
          AND ($3::timestamptz IS NULL OR processing_claimed_at = $3::timestamptz)
        RETURNING expires_at`,
      [storyId, STORY_TTL_HOURS, claim],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`UPDATE story_audiences SET expires_at = $2 WHERE story_id = $1`, [
      storyId,
      row.expires_at,
    ]);
    await client.query("COMMIT");
    bumpStoryStat("published");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The story is refused (scanner, a video over the limit, a file that is not
 * what it said): never visible. `hold` keeps its bytes as evidence.
 */
export async function refuseStory(
  storyId: string,
  hold: { until: "quarantine" | "none" | "forever" },
  error: string | null,
): Promise<void> {
  // Not fenced on the video lease on purpose: a refusal (or a hold) is never
  // wrong to apply, whoever finds the reason first.
  await getPool().query(
    `UPDATE stories
        SET status = 'deleted', deleted_at = now(), processing_claimed_at = NULL,
            processing_error = $2,
            hold_until = CASE WHEN $3 = 'quarantine'
                              THEN now() + make_interval(days => $4) ELSE hold_until END,
            hold_forever = hold_forever OR $3 = 'forever'
      WHERE id = $1`,
    [storyId, error, hold.until, quarantineDays()],
  );
}

/** The scanner's verdict, onto the row. */
export async function recordStoryScan(storyId: string, result: ScanResult): Promise<void> {
  if (result.status === "unscanned") {
    return;
  }
  await getPool().query(
    `UPDATE stories
        SET scan_status = $2, scan_provider = $3, scan_score = $4,
            scan_labels = $5::jsonb, scanned_at = now()
      WHERE id = $1`,
    [storyId, result.status, result.provider, result.score, JSON.stringify(result.labels)],
  );
}

/**
 * What a verdict means for the story, the same rule chat attachments follow
 * (`scanAllowsAttachment`), plus the holds:
 *
 * - rejected: never visible, bytes held for the quarantine window, or forever
 *   for an illegal-content match; an automated report is filed.
 * - error: never visible when the scanner fails closed (the default); no hold.
 * - flagged: visible, held for the quarantine window, reported.
 * - pass / skipped / unscanned: visible.
 *
 * Returns whether the story may go live.
 */
export async function applyStoryScan(
  row: { id: string; author_id: string },
  result: ScanResult,
  subject: string,
): Promise<boolean> {
  await recordStoryScan(row.id, result);
  if (result.status === "rejected" || result.status === "flagged") {
    // Filed first, and allowed to throw: a refused or flagged story must never
    // be finalised without its queue entry. A failure here leaves the story
    // where it was (pending, or processing), so the publish or the job retries
    // the whole thing.
    await escalateStoryScan(row, result, subject);
  }
  if (result.illegal) {
    console.error(
      `[content-safety] ILLEGAL-CONTENT MATCH: story ${row.id}, uploader ` +
        `${row.author_id}, provider ${result.provider}, labels ` +
        `${result.labels.join(",")}. Object retained and NOT deleted. ` +
        `See docs/CONTENT_SAFETY.md before touching it.`,
    );
  }
  const allowed = scanAllowsAttachment(result);
  if (!allowed) {
    await refuseStory(
      row.id,
      { until: result.illegal ? "forever" : result.status === "rejected" ? "quarantine" : "none" },
      `scan ${result.status}`,
    );
    bumpStoryStat(result.status === "rejected" ? "scanRejected" : "scanErrored");
  } else if (result.status === "flagged") {
    await getPool().query(
      `UPDATE stories
          SET hold_until = GREATEST(COALESCE(hold_until, now()), now() + make_interval(days => $2))
        WHERE id = $1`,
      [row.id, quarantineDays()],
    );
    bumpStoryStat("scanFlagged");
  }
  return allowed;
}

async function escalateStoryScan(
  row: { id: string; author_id: string },
  result: ScanResult,
  subject: string,
): Promise<void> {
  const reason = result.labels.includes("illegal") || result.labels.includes("csam_suspected")
    ? ("minor_sexual" as const)
    : result.labels.includes("minor_present")
      ? ("illegal_content" as const)
      : result.labels.includes("gore")
        ? ("violence" as const)
        : ("other" as const);
  const targets = await storyAudienceTargets(row.id);
  await createAutomatedStoryReport({
      storyId: row.id,
      reportedUserId: row.author_id,
      // One report, in the first server the story went to (where its staff
      // would have seen it); none means the instance queue. An illegal match
      // goes to the instance queue whatever the audience (`minor_sexual`).
      serverId: targets.serverIds[0] ?? null,
      reason,
      details:
        `Automated image scan (${result.provider}) returned ${result.status} for story ` +
        `${row.id} (${subject}): ${result.labels.join(", ") || "no labels"} ` +
        `(score ${result.score ?? "n/a"}). ` +
        (result.status === "rejected"
          ? "The story was refused and never shown; its bytes are held."
          : "The story is visible and its bytes are held."),
  });
}

export interface PublishedStory {
  story: Story;
  /** True when the story went live in this call (and the audience is to be told). */
  wentLive: boolean;
}

/**
 * `POST /api/stories/:storyId/publish`.
 *
 * The HEAD and the prefix read run before anything is written, and outside
 * any transaction; the scan too. An image is scanned BEFORE it is live, so
 * the window in which an unsafe one is visible is zero. A video goes to
 * `processing` and the stories job takes it from there (`story-media.ts`).
 */
export async function publishStory(user: DbUser, storyId: string): Promise<PublishedStory> {
  const result = await getPool().query<StoryRow>(
    `SELECT ${STORY_COLUMNS} FROM stories s JOIN users u ON u.id = s.author_id
      WHERE s.id = $1 AND s.author_id = $2`,
    [storyId, user.id],
  );
  const row = result.rows[0];
  if (!row || row.status === "deleted" || row.status === "expired") {
    throw new StoryError("not_found", "Story not found");
  }
  if (row.status !== "pending") {
    // Already processing or live: answering again is what makes a retried
    // publish (a dropped response) harmless.
    return { story: await getStoryForViewer(user.id, storyId), wentLive: false };
  }
  const key = row.media_storage_key;
  if (!key || !row.media_content_type || !isStoryKey(user.id, storyId, key)) {
    throw new StoryError("invalid", "Nothing to publish");
  }
  if (!isStorageConfigured()) {
    throw new StoryError("storage_off", "Media uploads are not configured");
  }

  const prefixRead = getObjectPrefix(key, STORY_SNIFF_BYTES).then(
    (bytes) => ({ ok: true as const, bytes }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let head;
  try {
    head = await headObject(key);
  } catch (error) {
    console.error(
      `[stories] HEAD failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    throw new StoryError("not_verified", "Upload could not be verified");
  }
  const read = await prefixRead;
  if (!head || head.contentLength <= 0) {
    throw new StoryError("not_verified", "Upload missing");
  }
  if (head.contentLength > STORY_MAX_BYTES || head.contentLength !== row.media_byte_size) {
    throw new StoryError("not_verified", "Upload size does not match");
  }
  if (!read.ok || !read.bytes) {
    throw new StoryError("not_verified", "Upload could not be verified");
  }
  const sniffed = sniffStoryMediaType(read.bytes);
  const isImage = row.kind === "image";
  const typeOk = isImage
    ? sniffed !== null && isStoryImageType(sniffed) && isStoryImageType(head.contentType)
    : sniffed === "video/mp4" && head.contentType === "video/mp4";
  if (!typeOk || !sniffed) {
    await refuseStory(storyId, { until: "none" }, "not the type it said");
    throw new StoryError("not_verified", "The file is not what it said it was");
  }
  if (sniffed !== row.media_content_type) {
    // A real JPEG saved as `.png` is a fine picture: keep what the bytes are.
    await getPool().query(`UPDATE stories SET media_content_type = $2 WHERE id = $1`, [
      storyId,
      sniffed,
    ]);
  }

  if (isImage) {
    const scan = isContentScanConfigured()
      ? await scanImage({
          imageUrl: presignGet(key, { ttlSeconds: SCAN_URL_TTL_SECONDS }),
          contentType: sniffed,
        })
      : null;
    if (scan) {
      bumpStoryStat("imagesScanned");
      const allowed = await applyStoryScan(row, scan, "image");
      if (!allowed) {
        // No reason leaks to the author: "Não subiu", like a failed upload.
        throw new StoryError("refused", "This story could not be posted");
      }
    }
    const wentLive = await goLive(storyId);
    return { story: await getStoryForViewer(user.id, storyId), wentLive };
  }

  // A video. With no scanner and nothing that can probe it, it goes live as
  // it is (unscanned, which is the truth). Otherwise the job checks it.
  if (!isContentScanConfigured() && !(await storyVideoProcessorAvailable())) {
    const wentLive = await goLive(storyId);
    return { story: await getStoryForViewer(user.id, storyId), wentLive };
  }
  await getPool().query(
    `UPDATE stories SET status = 'processing' WHERE id = $1 AND status = 'pending'`,
    [storyId],
  );
  return { story: await getStoryForViewer(user.id, storyId), wentLive: false };
}

// ------------------------------------------------------------------ views, reactions

/**
 * `POST /api/stories/views`. Idempotent; never the author's own. Returns the
 * authors whose stories got a NEW view, for their throttled `own` nudge.
 */
export async function recordViews(
  viewerId: string,
  storyIds: string[],
): Promise<{ recorded: number; authorIds: string[] }> {
  const { rows } = await loadVisible(viewerId, storyIds);
  const others = rows.filter((row) => row.author_id !== viewerId && row.status === "live");
  if (others.length === 0) {
    return { recorded: 0, authorIds: [] };
  }
  const inserted = await getPool().query<{ story_id: string }>(
    `INSERT INTO story_views (story_id, viewer_id)
     SELECT unnest($1::uuid[]), $2
     ON CONFLICT DO NOTHING
     RETURNING story_id`,
    [others.map((row) => row.id), viewerId],
  );
  const fresh = new Set(inserted.rows.map((row) => row.story_id));
  if (fresh.size > 0) {
    bumpStoryStat("views", fresh.size);
  }
  return {
    recorded: fresh.size,
    authorIds: [
      ...new Set(others.filter((row) => fresh.has(row.id)).map((row) => row.author_id)),
    ],
  };
}

/** `PUT /api/stories/:storyId/reaction`. Marks it seen too. Returns the author. */
export async function setReaction(
  viewerId: string,
  storyId: string,
  reaction: StoryReaction | null,
): Promise<string> {
  const { row } = await requireVisible(viewerId, storyId);
  if (row.author_id === viewerId || row.status !== "live") {
    throw new StoryError("invalid", "You cannot react to your own story");
  }
  await getPool().query(
    `INSERT INTO story_views (story_id, viewer_id, reaction, reacted_at)
     VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (story_id, viewer_id) DO UPDATE
       SET reaction = EXCLUDED.reaction, reacted_at = EXCLUDED.reacted_at`,
    [storyId, viewerId, reaction],
  );
  if (reaction) {
    bumpStoryStat("reactions");
  }
  return row.author_id;
}

/**
 * The checks a reply has to pass before it becomes a DM: the story is
 * visible, not the viewer's own, and its replies are on. DM privacy, blocks
 * and limits are the DM path's own job (`openConversation`, `postChannelMessage`).
 */
export async function prepareStoryReply(
  viewerId: string,
  storyId: string,
): Promise<{ authorId: string }> {
  const { row } = await requireVisible(viewerId, storyId);
  if (row.author_id === viewerId || row.status !== "live") {
    throw new StoryError("invalid", "You cannot reply to your own story");
  }
  if (!row.replies_enabled) {
    throw new StoryError("replies_off", "Replies are off for this story");
  }
  return { authorId: row.author_id };
}

export async function markReplied(viewerId: string, storyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO story_views (story_id, viewer_id, replied_at) VALUES ($1, $2, now())
     ON CONFLICT (story_id, viewer_id) DO UPDATE SET replied_at = now()`,
    [storyId, viewerId],
  );
  bumpStoryStat("replies");
}

// ------------------------------------------------------------------ viewers

interface ViewerCursor {
  at: string;
  id: string;
}

function encodeCursor(cursor: ViewerCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): ViewerCursor | null {
  if (!raw) {
    return null;
  }
  try {
    const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) {
      return null;
    }
    return { at, id };
  } catch {
    return null;
  }
}

/** `GET /api/stories/:storyId/viewers`: the author only, newest first. */
export async function listViewers(
  authorId: string,
  storyId: string,
  rawCursor: string | null,
): Promise<StoryViewersPage> {
  const owner = await getPool().query<{ author_id: string }>(
    `SELECT author_id FROM stories WHERE id = $1 AND status IN ('live', 'processing', 'pending')`,
    [storyId],
  );
  if (owner.rows[0]?.author_id !== authorId) {
    throw new StoryError("not_found", "Story not found");
  }
  const cursor = decodeCursor(rawCursor);
  const rows = await getPool().query<{
    viewer_id: string;
    viewed_at: Date;
    reaction: StoryReaction | null;
    replied_at: Date | null;
    display_name: string;
    avatar_url: string | null;
    handle: string | null;
  }>(
    `SELECT v.viewer_id, v.viewed_at, v.reaction, v.replied_at,
            u.display_name, u.avatar_url, u.handle
       FROM story_views v JOIN users u ON u.id = v.viewer_id
      WHERE v.story_id = $1
        AND ($2::timestamptz IS NULL OR (v.viewed_at, v.viewer_id) < ($2::timestamptz, $3::uuid))
      ORDER BY v.viewed_at DESC, v.viewer_id DESC
      LIMIT ${STORY_VIEWERS_PAGE_SIZE + 1}`,
    [storyId, cursor?.at ?? null, cursor?.id ?? null],
  );
  const counts = await ownCounts([storyId]);
  const page = rows.rows.slice(0, STORY_VIEWERS_PAGE_SIZE);
  const last = page.at(-1);
  return {
    viewers: page.map((row) => ({
      user: {
        id: row.viewer_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        handle: row.handle,
      },
      viewedAt: row.viewed_at.toISOString(),
      reaction: row.reaction,
      replied: row.replied_at !== null,
    })),
    nextCursor:
      rows.rows.length > STORY_VIEWERS_PAGE_SIZE && last
        ? encodeCursor({ at: last.viewed_at.toISOString(), id: last.viewer_id })
        : null,
    viewCount: counts.get(storyId)?.views ?? 0,
    reactionCount: counts.get(storyId)?.reactions ?? 0,
  };
}

// ------------------------------------------------------------------ delete, remove

/**
 * Take a story down everywhere: the author (`DELETE /api/stories/:id`), or an
 * instance moderator acting on a report. The bytes go now unless something
 * holds them (a report, a flag); the sweep retries a failed delete.
 */
export async function deleteStoryEverywhere(
  storyId: string,
  authorId: string | null,
): Promise<{ authorId: string; targets: AudienceTargets } | null> {
  const updated = await getPool().query<{ author_id: string }>(
    `UPDATE stories SET status = 'deleted', deleted_at = now(), processing_claimed_at = NULL
      WHERE id = $1 AND status <> 'deleted'
        AND ($2::uuid IS NULL OR author_id = $2::uuid)
      RETURNING author_id`,
    [storyId, authorId],
  );
  const row = updated.rows[0];
  if (!row) {
    return null;
  }
  if (authorId === null) {
    bumpStoryStat("removedEverywhere");
  }
  const targets = await storyAudienceTargets(storyId);
  return { authorId: row.author_id, targets };
}

/**
 * A moderator with MANAGE_MESSAGES in `serverId` takes the story out of that
 * server only. Writes the author's one-time notice (not when a moderator
 * removes their own). Returns null when there was nothing to remove.
 */
export async function removeStoryFromServer(input: {
  serverId: string;
  storyId: string;
  moderatorId: string;
  reason: string | null;
}): Promise<{ authorId: string } | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const removed = await client.query<{ author_id: string; server_name: string }>(
      `UPDATE story_audiences a
          SET removed_at = now(), removed_by = $3, removed_reason = $4
         FROM stories s, servers srv
        WHERE a.story_id = $2 AND a.server_id = $1 AND a.removed_at IS NULL
          AND s.id = a.story_id AND s.status IN ('live', 'processing', 'pending')
          AND srv.id = a.server_id
        RETURNING s.author_id, srv.name AS server_name`,
      [input.serverId, input.storyId, input.moderatorId, input.reason],
    );
    const row = removed.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    if (row.author_id !== input.moderatorId) {
      await client.query(
        `INSERT INTO story_notices (user_id, kind, story_id, server_id, server_name, reason)
         VALUES ($1, 'removed', $2, $3, $4, $5)`,
        [row.author_id, input.storyId, input.serverId, row.server_name, input.reason],
      );
    }
    await client.query("COMMIT");
    bumpStoryStat("removedByStaff");
    return { authorId: row.author_id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * An account is being deleted: take its stories with it, except what is held.
 *
 * Runs before `DELETE FROM users` (whose `ON DELETE SET NULL` then leaves the
 * remaining rows authorless). Text cards nothing holds are deleted outright.
 * Media stories nothing holds are marked deleted with their words cleared, so
 * the sweep removes their bytes within a minute and the row right after
 * (`author_id IS NULL` skips the week of retention). A HELD story (an open or
 * recent report, a scan hold, an illegal-content match) is marked deleted and
 * kept whole, author or not: it is evidence, and the sweep's hold rule keeps
 * its bytes exactly as long as it would have with the account alive.
 */
export async function retireAuthorStories(authorId: string): Promise<void> {
  const held = STORY_HELD_FOR_ACCOUNT_SQL;
  await getPool().query(
    `DELETE FROM stories s
      WHERE s.author_id = $1 AND s.kind = 'text' AND NOT ${held}`,
    [authorId],
  );
  await getPool().query(
    `UPDATE stories s
        SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()),
            processing_claimed_at = NULL,
            caption = CASE WHEN ${held} THEN caption ELSE NULL END,
            sticker = CASE WHEN ${held} THEN sticker ELSE NULL END
      WHERE s.author_id = $1`,
    [authorId],
  );
}

/** `STORY_HELD_SQL` in story-media.ts, restated here to keep the import one way. */
const STORY_HELD_FOR_ACCOUNT_SQL = `(
  s.hold_forever
  OR (s.hold_until IS NOT NULL AND s.hold_until > now())
  OR EXISTS (
    SELECT 1 FROM reports r
     WHERE r.reported_story_id = s.id
       AND (r.status = 'open' OR r.resolved_at > now() - interval '30 days')
  )
)`;

// ------------------------------------------------------------------ mutes, notices

export async function muteAuthor(userId: string, mutedUserId: string): Promise<void> {
  if (userId === mutedUserId) {
    throw new StoryError("invalid", "You cannot mute yourself");
  }
  const exists = await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [mutedUserId]);
  if ((exists.rowCount ?? 0) === 0) {
    throw new StoryError("not_found", "User not found");
  }
  await getPool().query(
    `INSERT INTO story_mutes (user_id, muted_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, mutedUserId],
  );
}

export async function unmuteAuthor(userId: string, mutedUserId: string): Promise<void> {
  await getPool().query(`DELETE FROM story_mutes WHERE user_id = $1 AND muted_user_id = $2`, [
    userId,
    mutedUserId,
  ]);
}

export async function listStoryNotices(userId: string): Promise<StoryNotice[]> {
  const result = await getPool().query<{
    id: string;
    story_id: string | null;
    server_id: string | null;
    server_name: string | null;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT id, story_id, server_id, server_name, reason, created_at
       FROM story_notices
      WHERE user_id = $1 AND acked_at IS NULL
      ORDER BY created_at DESC LIMIT 20`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: "removed" as const,
    storyId: row.story_id,
    serverId: row.server_id,
    serverName: row.server_name,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function ackStoryNotice(userId: string, noticeId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE story_notices SET acked_at = now()
      WHERE id = $1 AND user_id = $2 AND acked_at IS NULL`,
    [noticeId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ------------------------------------------------------------------ the DM quote

/**
 * `GET /api/stories/:storyId/card`, for a DM quote. Only for somebody who can
 * read a conversation holding a message that quotes the story; never media or
 * words once it has expired or been taken down.
 */
export async function getStoryCard(viewerId: string, storyId: string): Promise<StoryCard> {
  // A conversation THIS viewer is in that quotes the story, however many other
  // conversations quote it too. Conversation access is membership (no role
  // escape hatch, see `channelVisibleSql`), so the join is the whole check.
  const quoting = await getPool().query(
    `SELECT 1 FROM messages m
       JOIN channels c ON c.id = m.channel_id AND c.kind <> 'server'
       JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $2
      WHERE m.story_id = $1
      LIMIT 1`,
    [storyId, viewerId],
  );
  if ((quoting.rowCount ?? 0) === 0) {
    throw new StoryError("not_found", "Story not found");
  }
  const result = await getPool().query<StoryRow & { all_removed: boolean; blocked: boolean }>(
    `SELECT ${STORY_COLUMNS},
            NOT EXISTS (
              SELECT 1 FROM story_audiences a WHERE a.story_id = s.id AND a.removed_at IS NULL
            ) AS all_removed,
            NOT ${noBlockBetweenSql("s.author_id", "$2::uuid")} AS blocked
       FROM stories s JOIN users u ON u.id = s.author_id
      WHERE s.id = $1`,
    [storyId, viewerId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new StoryError("not_found", "Story not found");
  }
  const live =
    row.status === "live" && row.expires_at !== null && row.expires_at.getTime() > Date.now();
  // A block in either direction shows the quote as gone, like every other read.
  if (!live || row.all_removed || row.blocked) {
    return {
      storyId,
      state: row.status === "deleted" || row.all_removed || row.blocked ? "removed" : "expired",
      authorId: row.author_id,
      kind: null,
      posterUrl: null,
      caption: null,
      text: null,
      background: null,
      expiresAt: null,
    };
  }
  const media = mediaOf(row);
  return {
    storyId,
    state: "live",
    authorId: row.author_id,
    kind: row.kind,
    posterUrl: row.kind === "video" ? (media?.posterUrl ?? null) : (media?.url ?? null),
    caption: row.caption,
    text: row.text_body,
    background: (row.background as StoryBackground | null) ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

// ------------------------------------------------------------------ reports

/**
 * What a story report needs, if the reporter can see the story through the
 * audience they name. Not visible is one answer, like every report subject.
 */
export async function resolveStoryForReport(
  reporterId: string,
  storyId: string,
  serverId: string | null,
): Promise<{
  authorId: string;
  snapshot: string | null;
  serverId: string | null;
} | null> {
  const { rows, audiences } = await loadVisible(reporterId, [storyId]);
  const row = rows[0];
  if (!row || row.author_id === reporterId) {
    return null;
  }
  const seen = audiences.get(row.id) ?? [];
  const through = serverId
    ? seen.find((audience) => audience.kind === "server" && audience.serverId === serverId)
    : seen.find((audience) => audience.kind === "friends");
  if (!through) {
    return null;
  }
  return {
    authorId: row.author_id,
    snapshot: row.text_body ?? row.caption ?? null,
    serverId: through.kind === "server" ? through.serverId : null,
  };
}

// ------------------------------------------------------------------ Baú

/** The story's media, for "Salvar no Baú". The route does the copy. */
export async function storyForBau(
  authorId: string,
  storyId: string,
  serverId: string,
): Promise<{
  key: string | null;
  contentType: string | null;
  byteSize: number | null;
  caption: string | null;
  text: string | null;
  kind: StoryKind;
  scan: {
    status: string;
    provider: string | null;
    score: number | null;
    labels: unknown;
    scannedAt: Date | null;
  };
}> {
  const result = await getPool().query<{
    media_storage_key: string | null;
    media_content_type: string | null;
    media_byte_size: number | null;
    caption: string | null;
    text_body: string | null;
    kind: StoryKind;
    scan_status: string;
    scan_provider: string | null;
    scan_score: number | null;
    scan_labels: unknown;
    scanned_at: Date | null;
  }>(
    `SELECT s.media_storage_key, s.media_content_type, s.media_byte_size,
            s.caption, s.text_body, s.kind, s.scan_status, s.scan_provider,
            s.scan_score, s.scan_labels, s.scanned_at
       FROM stories s
       JOIN story_audiences a
         ON a.story_id = s.id AND a.server_id = $3 AND a.removed_at IS NULL
      WHERE s.id = $1 AND s.author_id = $2
        AND s.status = 'live' AND s.expires_at > now()
        AND s.media_deleted_at IS NULL`,
    [storyId, authorId, serverId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new StoryError("not_found", "Story not found");
  }
  return {
    key: row.media_storage_key,
    contentType: row.media_content_type,
    byteSize: row.media_byte_size,
    caption: row.caption,
    text: row.text_body,
    kind: row.kind,
    scan: {
      status: row.scan_status,
      provider: row.scan_provider,
      score: row.scan_score,
      labels: row.scan_labels,
      scannedAt: row.scanned_at,
    },
  };
}

/** Accepted friends of `userId`, for the friends nudge. */
export async function listFriendIds(userId: string): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `SELECT CASE WHEN low_user_id = $1 THEN high_user_id ELSE low_user_id END AS id
       FROM friendships
      WHERE status = 'accepted' AND (low_user_id = $1 OR high_user_id = $1)`,
    [userId],
  );
  return result.rows.map((row) => row.id);
}

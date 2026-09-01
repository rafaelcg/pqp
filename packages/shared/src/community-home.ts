import { z } from "zod";
import { publicUserSchema, safeTextSchema } from "./api.js";
import {
  ATTACHMENT_FILENAME_MAX_LENGTH,
  attachmentFilenameSchema,
} from "./attachments.js";

/**
 * Community Home (Baú) — durable media feed per server.
 *
 * Not a channel type. Posts live in Postgres; media bytes go through the same
 * S3/R2 mint → PUT → claim dance as attachments. Visibility is enforced on the
 * API: members-only body/media are omitted unless the viewer has MANAGE_SERVER
 * or the VIP cargo. Drafts and scheduled posts are never returned to members.
 *
 * `VITE_COMMUNITY_HOME_ENABLED` is a separate client latch from
 * `COMMUNITIES_ENABLED` (legal Art. 19). This module is the wire contract only.
 */

export const COMMUNITY_HOME_MAX_BYTES = 10 * 1024 * 1024;

export const COMMUNITY_HOME_TITLE_MAX = 200;
export const COMMUNITY_HOME_BODY_MAX = 4000;
export const COMMUNITY_HOME_TEASER_MAX = 500;
export const COMMUNITY_HOME_COMMENT_MAX = 1000;

/** Free for everyone in the server, or members-only (VIP / staff unlock). */
export const communityHomeVisibilitySchema = z.enum(["free", "members"]);
export type CommunityHomeVisibility = z.infer<
  typeof communityHomeVisibilitySchema
>;

export const communityHomePostStatusSchema = z.enum([
  "draft",
  "published",
  "scheduled",
]);
export type CommunityHomePostStatus = z.infer<
  typeof communityHomePostStatusSchema
>;

export const communityHomeMediaKindSchema = z.enum([
  "image",
  "video",
  "youtube",
  "file",
]);
export type CommunityHomeMediaKind = z.infer<
  typeof communityHomeMediaKindSchema
>;

/** Chip on the card. VIP is never shown this pass; staff = MANAGE_SERVER. */
export const communityHomeAuthorBadgeSchema = z.enum(["owner", "staff"]);
export type CommunityHomeAuthorBadge = z.infer<
  typeof communityHomeAuthorBadgeSchema
>;

/**
 * MIME types Home will mint an upload for. Subset of attachment allowlist —
 * no audio; video capped at the Home 10 MiB product rule.
 */
export const COMMUNITY_HOME_MIME_ALLOWLIST = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "application/pdf",
] as const;

export type CommunityHomeContentType =
  (typeof COMMUNITY_HOME_MIME_ALLOWLIST)[number];

export const communityHomeContentTypeSchema = z.enum(
  COMMUNITY_HOME_MIME_ALLOWLIST,
);

export function communityHomeMediaKindFromContentType(
  contentType: CommunityHomeContentType,
): "image" | "video" | "file" {
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

/**
 * Extract a YouTube video id from watch / youtu.be / shorts / embed / live URLs.
 */
export function parseYoutubeVideoId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v");
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        (parts[0] === "shorts" ||
          parts[0] === "embed" ||
          parts[0] === "live") &&
        parts[1] &&
        /^[\w-]{11}$/.test(parts[1])
      ) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function youtubeEmbedSrc(youtubeUrl: string): string | null {
  const id = parseYoutubeVideoId(youtubeUrl);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

export const communityHomeYoutubeUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => parseYoutubeVideoId(value) != null, "Invalid YouTube URL");

/** Media as returned to a viewer who may see it. Locked viewers get null. */
export const communityHomeMediaSchema = z.object({
  kind: communityHomeMediaKindSchema,
  name: z.string(),
  contentType: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  /** Presigned GET when storage-backed; null for YouTube. */
  url: z.string().nullable(),
  youtubeUrl: z.string().nullable(),
});

export type CommunityHomeMedia = z.infer<typeof communityHomeMediaSchema>;

export const communityHomeCommentSchema = z.object({
  id: z.string().uuid(),
  author: publicUserSchema,
  body: z.string(),
  createdAt: z.string(),
});

export type CommunityHomeComment = z.infer<typeof communityHomeCommentSchema>;

export const communityHomePostSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  author: publicUserSchema,
  authorBadge: communityHomeAuthorBadgeSchema.nullable(),
  title: z.string().nullable(),
  /**
   * Omitted (null) for members-only posts when the viewer cannot unlock —
   * the API strips it; the client must not invent body from teaser.
   */
  body: z.string().nullable(),
  teaser: z.string().nullable(),
  visibility: communityHomeVisibilitySchema,
  status: communityHomePostStatusSchema,
  commentsEnabled: z.boolean(),
  media: communityHomeMediaSchema.nullable(),
  /** True when body/media were stripped for this viewer. */
  locked: z.boolean(),
  likeCount: z.number().int().nonnegative(),
  likedByMe: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  /** Up to two newest comments for the card teaser. */
  commentTeaser: z.array(communityHomeCommentSchema).max(2),
  scheduledAt: z.string().nullable(),
  /** IANA timezone the author picked when scheduling (display + compose). */
  scheduleTimezone: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CommunityHomePost = z.infer<typeof communityHomePostSchema>;

const titleSchema = z
  .string()
  .trim()
  .max(COMMUNITY_HOME_TITLE_MAX)
  .pipe(safeTextSchema);

const bodySchema = z
  .string()
  .trim()
  .max(COMMUNITY_HOME_BODY_MAX)
  .pipe(safeTextSchema);

const teaserSchema = z
  .string()
  .trim()
  .max(COMMUNITY_HOME_TEASER_MAX)
  .pipe(safeTextSchema);

/**
 * Create / save a post. Title required for publish/schedule at the route;
 * drafts may omit title. At least body or media is required to leave draft
 * toward publish — enforced in the service.
 */
export const createCommunityHomePostSchema = z.object({
  title: z.string().max(COMMUNITY_HOME_TITLE_MAX).optional().nullable(),
  body: z.string().max(COMMUNITY_HOME_BODY_MAX).optional().nullable(),
  teaser: z.string().max(COMMUNITY_HOME_TEASER_MAX).optional().nullable(),
  visibility: communityHomeVisibilitySchema.default("free"),
  commentsEnabled: z.boolean().optional(),
  /** Claimed media upload id, or omit / null for text-only / YouTube. */
  mediaUploadId: z.string().uuid().optional().nullable(),
  youtubeUrl: z.string().max(500).optional().nullable(),
  /**
   * Intent on create. `published` / `scheduled` require title + (body|media).
   * Dirty-close from compose uses `draft`.
   */
  status: communityHomePostStatusSchema.default("draft"),
  scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
  scheduleTimezone: z.string().min(1).max(64).optional().nullable(),
});

export type CreateCommunityHomePostRequest = z.infer<
  typeof createCommunityHomePostSchema
>;

export const updateCommunityHomePostSchema = z.object({
  title: z.string().max(COMMUNITY_HOME_TITLE_MAX).optional().nullable(),
  body: z.string().max(COMMUNITY_HOME_BODY_MAX).optional().nullable(),
  teaser: z.string().max(COMMUNITY_HOME_TEASER_MAX).optional().nullable(),
  visibility: communityHomeVisibilitySchema.optional(),
  commentsEnabled: z.boolean().optional(),
  mediaUploadId: z.string().uuid().optional().nullable(),
  youtubeUrl: z.string().max(500).optional().nullable(),
  /** Pass null to clear media (including YouTube). */
  clearMedia: z.boolean().optional(),
});

export type UpdateCommunityHomePostRequest = z.infer<
  typeof updateCommunityHomePostSchema
>;

export const scheduleCommunityHomePostSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  /** IANA tz name for display (e.g. America/Sao_Paulo). */
  scheduleTimezone: z.string().min(1).max(64),
});

export type ScheduleCommunityHomePostRequest = z.infer<
  typeof scheduleCommunityHomePostSchema
>;

export const createCommunityHomeCommentSchema = z.object({
  body: z.string().max(COMMUNITY_HOME_COMMENT_MAX * 2),
});

export type CreateCommunityHomeCommentRequest = z.infer<
  typeof createCommunityHomeCommentSchema
>;

export const communityHomeCommentBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(COMMUNITY_HOME_COMMENT_MAX)
  .pipe(safeTextSchema);

export const createCommunityHomeMediaUploadSchema = z.object({
  contentType: communityHomeContentTypeSchema,
  byteSize: z.number().int().positive().max(COMMUNITY_HOME_MAX_BYTES),
  filename: attachmentFilenameSchema,
});

export type CreateCommunityHomeMediaUploadRequest = z.infer<
  typeof createCommunityHomeMediaUploadSchema
>;

export const createCommunityHomeMediaUploadResponseSchema = z.object({
  uploadId: z.string().uuid(),
  key: z.string(),
  uploadUrl: z.string(),
  expiresAt: z.string(),
  kind: z.enum(["image", "video", "file"]),
});

export type CreateCommunityHomeMediaUploadResponse = z.infer<
  typeof createCommunityHomeMediaUploadResponseSchema
>;

export const claimCommunityHomeMediaSchema = z.object({
  uploadId: z.string().uuid(),
});

export type ClaimCommunityHomeMediaRequest = z.infer<
  typeof claimCommunityHomeMediaSchema
>;

export const claimCommunityHomeMediaResponseSchema = z.object({
  uploadId: z.string().uuid(),
  kind: z.enum(["image", "video", "file"]),
  name: z.string().max(ATTACHMENT_FILENAME_MAX_LENGTH),
  contentType: communityHomeContentTypeSchema,
  byteSize: z.number().int().positive(),
});

export type ClaimCommunityHomeMediaResponse = z.infer<
  typeof claimCommunityHomeMediaResponseSchema
>;

export const communityHomePostsResponseSchema = z.object({
  posts: z.array(communityHomePostSchema),
});

export type CommunityHomePostsResponse = z.infer<
  typeof communityHomePostsResponseSchema
>;

export const communityHomePostResponseSchema = z.object({
  post: communityHomePostSchema,
});

export type CommunityHomePostResponse = z.infer<
  typeof communityHomePostResponseSchema
>;

export const communityHomeCommentsResponseSchema = z.object({
  comments: z.array(communityHomeCommentSchema),
});

export type CommunityHomeCommentsResponse = z.infer<
  typeof communityHomeCommentsResponseSchema
>;

export const communityHomeLikeResponseSchema = z.object({
  liked: z.boolean(),
  likeCount: z.number().int().nonnegative(),
});

export type CommunityHomeLikeResponse = z.infer<
  typeof communityHomeLikeResponseSchema
>;

/** WS nudge: clients refetch Home for this server. Not a channel broadcast. */
export const communityHomeUpdateSchema = z.object({
  type: z.literal("community-home-update"),
  serverId: z.string().uuid(),
});

export type CommunityHomeUpdate = z.infer<typeof communityHomeUpdateSchema>;

/** Parsed create fields after route-level safeText application. */
export type ParsedCommunityHomePostFields = {
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

export function parseCommunityHomeTitle(
  value: string | null | undefined,
): string | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  return titleSchema.parse(value);
}

export function parseCommunityHomeBody(
  value: string | null | undefined,
): string {
  if (value == null || value.trim() === "") {
    return "";
  }
  return bodySchema.parse(value);
}

export function parseCommunityHomeTeaser(
  value: string | null | undefined,
): string | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  return teaserSchema.parse(value);
}

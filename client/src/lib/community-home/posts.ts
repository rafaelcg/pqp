/**
 * Baú posts — the wire types, re-exported from `@pqp/shared` so call sites in
 * `client/` keep importing from `@/lib/community-home` rather than reaching
 * into the shared package directly.
 *
 * Posts are persisted on the API now (Postgres, real media via R2/MinIO).
 * There is no local CRUD here any more — every mutation goes through
 * `client/src/lib/api.ts`, which is the only thing that talks to the network.
 */

export {
  COMMUNITY_HOME_BODY_MAX,
  COMMUNITY_HOME_COMMENT_MAX,
  COMMUNITY_HOME_TEASER_MAX,
  COMMUNITY_HOME_TITLE_MAX,
  communityHomeMediaKindFromContentType,
  type ClaimCommunityHomeMediaResponse,
  type CommunityHomeAuthorBadge,
  type CommunityHomeComment,
  type CommunityHomeContentType,
  type CommunityHomeMedia,
  type CommunityHomeMediaKind,
  type CommunityHomePost,
  type CommunityHomePostStatus,
  type CommunityHomeVisibility,
  type CreateCommunityHomeMediaUploadResponse,
  type CreateCommunityHomePostRequest,
  type ScheduleCommunityHomePostRequest,
  type UpdateCommunityHomePostRequest,
} from "@pqp/shared";

/**
 * The teaser or title shown in place of a locked post's body — the client
 * must never fall back to inventing one from data the API already stripped.
 */
export function lockedPostSummary(post: {
  title: string | null;
  teaser: string | null;
}): string | null {
  return post.teaser?.trim() || post.title?.trim() || null;
}

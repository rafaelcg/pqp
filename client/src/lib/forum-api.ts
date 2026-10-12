import {
  FORUM_ERRORS,
  type CreateForumPostRequest,
  type ForumPostListResponse,
  type ForumPostSummary,
  type ForumPostViewer,
  type MessageRejectReason,
  type UpdateForumPostRequest,
} from "@pqp/shared";
import { ApiError, apiFetch } from "@/lib/api";
import type { ForumFilters } from "@/lib/forum-list";

/**
 * The pane's forum routes (list, similar, create, edit, delete, follow), as
 * frozen in `packages/shared/src/forums.ts` (the REST table in its header).
 * The shell's routes (a post by id, tags, settings) are in `lib/api.ts` and
 * re-exported below, so the pane imports every forum call from here.
 */

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** A 204 has no JSON body, which `apiFetch` reports as an error with that status. */
async function noContent(path: string, init: RequestInit): Promise<void> {
  try {
    await apiFetch<unknown>(path, init);
  } catch (error) {
    if (error instanceof ApiError && error.status === 204) {
      return;
    }
    throw error;
  }
}

/** The query string for one page; repeated `tag` keys are AND on the server. */
export function forumListQuery(
  filters: ForumFilters,
  cursor: string | null,
  limit?: number,
): string {
  const params = new URLSearchParams();
  params.set("sort", filters.sort);
  for (const tagId of filters.tagIds) {
    params.append("tag", tagId);
  }
  if (filters.status) {
    params.set("status", filters.status);
  }
  if (filters.mine) {
    params.set("mine", "true");
  }
  if (filters.q.trim()) {
    params.set("q", filters.q.trim());
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  if (limit) {
    params.set("limit", String(limit));
  }
  return params.toString();
}

export const fetchForumPosts = (
  forumId: string,
  filters: ForumFilters,
  cursor: string | null,
  signal?: AbortSignal,
) =>
  apiFetch<ForumPostListResponse>(
    `/api/channels/${forumId}/posts?${forumListQuery(filters, cursor)}`,
    signal ? { signal } : {},
  );

export const fetchSimilarForumPosts = (
  forumId: string,
  title: string,
  signal?: AbortSignal,
) =>
  apiFetch<{ posts: ForumPostSummary[] }>(
    `/api/channels/${forumId}/posts/similar?title=${encodeURIComponent(title)}`,
    signal ? { signal } : {},
  );

export const createForumPost = (forumId: string, body: CreateForumPostRequest) =>
  apiFetch<{ post: ForumPostSummary; viewer: ForumPostViewer }>(
    `/api/channels/${forumId}/posts`,
    json("POST", body),
  );


export const updateForumPost = (postId: string, patch: UpdateForumPostRequest) =>
  apiFetch<{ post: ForumPostSummary }>(
    `/api/forum-posts/${postId}`,
    json("PATCH", patch),
  );

export const deleteForumPost = (postId: string) =>
  noContent(`/api/forum-posts/${postId}`, json("DELETE"));

export const setForumPostFollow = (postId: string, following: boolean) =>
  apiFetch<{ viewer: ForumPostViewer }>(
    `/api/forum-posts/${postId}/follow`,
    json("PUT", { following }),
  );

// The shell's half of the surface (a post by id, tags, settings) lives in
// `lib/api.ts`; re-exported so the pane has one import for every forum call.
export { fetchForumPost, fetchForumSettings, fetchForumTags, putForumTags } from "@/lib/api";

/**
 * Why a publish was refused, in the composer's terms. The 422 body reuses a
 * `message-rejected` frame's fields (`forumPostRejectedBodySchema`), so the
 * copy is the chat composer's; `field` is read when the server names which
 * half AutoMod refused, and absent means the body.
 */
export type ForumPublishError =
  | { kind: "tag-required" }
  | { kind: "paused" }
  | { kind: "slow-mode"; retryAfterMs: number }
  | { kind: "rate-limited"; retryAfterMs: number | null }
  /** `field` null: the server did not say which half (the whole post). */
  | { kind: "automod"; field: "title" | "body" | null; message: string | null }
  | { kind: "cannot-send" }
  | { kind: "failed" };

export function readForumPublishError(error: unknown): ForumPublishError {
  if (!(error instanceof ApiError)) {
    return { kind: "failed" };
  }
  const details = (error.details ?? {}) as {
    error?: string;
    reason?: MessageRejectReason;
    retryAfterMs?: number;
    automodMessage?: string;
    field?: string;
  };
  const code = details.error ?? error.message;
  if (code === FORUM_ERRORS.tagRequired) {
    return { kind: "tag-required" };
  }
  if (code === FORUM_ERRORS.off) {
    return { kind: "paused" };
  }
  switch (details.reason) {
    case "slow-mode":
      return {
        kind: "slow-mode",
        retryAfterMs: details.retryAfterMs ?? error.retryAfterMs ?? 0,
      };
    case "rate-limited":
      return {
        kind: "rate-limited",
        retryAfterMs: details.retryAfterMs ?? error.retryAfterMs,
      };
    case "automod":
      return {
        kind: "automod",
        field:
          details.field === "title" || details.field === "body" ? details.field : null,
        message: details.automodMessage ?? null,
      };
    case "cannot-send":
      return { kind: "cannot-send" };
    default:
      break;
  }
  // The route's own "cannot post here" (no SEND_MESSAGES, a timeout).
  if (error.status === 403) {
    return { kind: "cannot-send" };
  }
  if (error.status === 429) {
    return { kind: "rate-limited", retryAfterMs: error.retryAfterMs };
  }
  return { kind: "failed" };
}

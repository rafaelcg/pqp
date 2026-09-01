import type { CommunityHomeVisibility } from "@pqp/shared";
import type { CommunityHomeViewerRole } from "./viewer";

export type { CommunityHomeVisibility } from "@pqp/shared";

/**
 * Whether `viewer` sees the full media/body of a post with this visibility.
 *
 * Free posts are open to everyone in the server. Members-only posts open for
 * owner (always) and VIP (the paid-cargo stand-in) — same rule the API
 * enforces server-side (`canUnlockMembers` in `services/community-home.ts`).
 *
 * This is used by the staff inspector to SIMULATE a role, not to decide what
 * is actually shown to a real signed-in viewer — for that, prefer
 * `post.locked` from the API, which already reflects the real caller. See
 * `isPostLockedForViewer` below, which is what call sites should use.
 */
export function canViewHomePostFull(
  visibility: CommunityHomeVisibility,
  viewer: CommunityHomeViewerRole,
): boolean {
  if (visibility === "free") {
    return true;
  }
  return viewer === "owner" || viewer === "vip";
}

export function homePostIsLocked(
  visibility: CommunityHomeVisibility,
  viewer: CommunityHomeViewerRole,
): boolean {
  return !canViewHomePostFull(visibility, viewer);
}

/**
 * The lock state to actually render for one post.
 *
 * `post.locked` from the API is authoritative for a real viewer — including
 * staff, for whom it is always `false` because MANAGE_SERVER always unlocks.
 * The staff inspector's `owner` / `members` modes override that on purpose,
 * so a manager can see the locked teaser without a second account; `auto`
 * never overrides, which is what keeps a plain member's own view untouched.
 */
export function isPostLockedForViewer(
  post: { visibility: CommunityHomeVisibility; locked: boolean },
  canManageServer: boolean,
  inspectorMode: "auto" | "owner" | "members",
): boolean {
  if (canManageServer && inspectorMode !== "auto") {
    return !canViewHomePostFull(post.visibility, inspectorMode);
  }
  return post.locked;
}

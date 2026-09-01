import type { CommunityHomeViewerRole } from "./viewer";

/** Who a Home post is for. `members` means the VIP / paid mock gate. */
export type CommunityHomeVisibility = "free" | "members";

/**
 * Whether this viewer sees the full media / body, or only the teaser + lock.
 *
 * Free posts are open to everyone in the community. Members-only posts open
 * for owner (composer) and VIP; free members get the locked teaser.
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

/**
 * Whether a live Baú publish should pop the corner card.
 *
 * The WS frame is empty (`community-home-update` carries only `serverId`),
 * so "a new post this person has not seen" is the unread count going up.
 * The author's own posts never count; pin / delete / unpublish / draft /
 * comment-delete fan out the same frame without raising it.
 *
 * Already looking at the feed is not a toast: the feed itself is the notice.
 * The caller only asks this for the server whose channel list is on screen;
 * a member sitting in DMs or another server is not "in" this one, and the
 * badge is waiting when they open it (which lands on Baú).
 */
export function shouldOfferCommunityHomePostToast(input: {
  lookingAtFeed: boolean;
  unreadBefore: number;
  unreadAfter: number;
}): boolean {
  if (input.lookingAtFeed) {
    return false;
  }
  return input.unreadAfter > input.unreadBefore;
}

/** How long the corner card stays up if nobody clicks it. */
export const COMMUNITY_HOME_POST_TOAST_MS = 8_000;

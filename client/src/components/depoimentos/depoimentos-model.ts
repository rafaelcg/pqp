import {
  DEPOIMENTO_MAX_LENGTH,
  PROFILE_COMMUNITY_LIMIT,
  type Depoimento,
  type ProfileCommunityList,
  type Server,
} from "@pqp/shared";
import type { FriendshipState } from "@/components/user/profile-relations";

/**
 * The depoimento feature's pure logic, out of the components so the decisions
 * that matter are testable without a DOM or a network.
 *
 * Every rule here has a counterpart on the server. That duplication is on
 * purpose and is stated the same way `profile-relations.ts` states it: the
 * client's copy decides what to DRAW, the server's decides what is ALLOWED, and
 * a client that draws an affordance the server would refuse is a worse bug than
 * one that hides an affordance the server would allow.
 */

/**
 * May the viewer write a depoimento about this person?
 *
 * Friends only, and never yourself — the same gate `areFriendsSql` enforces.
 * `pendingIncoming` and `pendingOutgoing` are deliberately NOT enough: half a
 * handshake is not a friendship, and offering the composer to somebody whose
 * request has not been answered would earn them a 403 they cannot explain.
 */
export function canWriteDepoimento(state: FriendshipState): boolean {
  return state === "friends";
}

/**
 * How many characters are left, as a signed number — negative once they have
 * run over, so a counter can turn red before the request does.
 *
 * Counts the TRIMMED length, because the server trims before measuring. A
 * composer that counted trailing whitespace would show 0 remaining while the
 * server happily accepted it, which is the small lie that makes a counter
 * untrustworthy.
 */
export function depoimentoRemaining(body: string): number {
  return DEPOIMENTO_MAX_LENGTH - body.trim().length;
}

/** Whether the composer's submit is live: something written, nothing over. */
export function canSubmitDepoimento(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.length > 0 && trimmed.length <= DEPOIMENTO_MAX_LENGTH;
}

/**
 * What the "+N" chip says, or null when there is nothing hidden.
 *
 * Derived rather than sent so the two numbers cannot disagree: the server caps
 * the array at `PROFILE_COMMUNITY_LIMIT` and reports the real total, and this
 * is the only place the difference is computed.
 */
export function communityOverflow(list: ProfileCommunityList): number | null {
  const hidden = list.total - list.communities.length;
  return hidden > 0 ? hidden : null;
}

/**
 * Whether a server's rail menu should offer "show this on my profile".
 *
 * ONLY FOR A LISTED COMMUNITY. A private server is never chipped onto anybody's
 * card, so offering the switch there would be offering a no-op — and worse, it
 * would imply that private servers ARE shown by default, which is the exact
 * misreading this feature must not create.
 */
export function offersProfileVisibility(server: Server): boolean {
  return server.isCommunity;
}

/**
 * The month-and-year line under a depoimento, in the viewer's locale.
 *
 * Month precision, deliberately. "julho de 2026" is what a testimonial wants to
 * say; a timestamp turns a keepsake into a log entry, and an exact date is also
 * a small fact about when two people were talking that nobody asked to publish.
 */
export function depoimentoDate(
  depoimento: Pick<Depoimento, "createdAt" | "approvedAt">,
  locale?: string,
): string {
  // The published date when there is one — a profile is ordered by it, so the
  // date shown has to be the one the order is in. A pending one has only ever
  // been written.
  const stamp = depoimento.approvedAt ?? depoimento.createdAt;
  return new Date(stamp).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
}

/**
 * Everything waiting on the viewer, as one number for one badge.
 *
 * Friend requests and pending depoimentos are counted TOGETHER, unlike unread
 * messages, which the rail keeps separate and says why. The test is what the
 * number promises: "somebody is waiting for you to answer something", and both
 * of these are answered from the same screen with the same two buttons. A
 * person who taps the badge and finds a depoimento instead of a friend request
 * has not been misled; a person who taps a mention badge and finds a friend
 * request has.
 */
export function waitingOnYou(counts: {
  friendRequests: number;
  pendingDepoimentos: number;
}): number {
  return counts.friendRequests + counts.pendingDepoimentos;
}

export { DEPOIMENTO_MAX_LENGTH, PROFILE_COMMUNITY_LIMIT };

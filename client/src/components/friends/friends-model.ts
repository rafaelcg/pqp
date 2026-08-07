import type { Friend, FriendsResponse } from "@pqp/shared";

/**
 * The view's little bit of pure logic, out of the component so it can be
 * tested without a DOM: which rows each tab shows, and what the badges count.
 */

export type FriendsTab = "online" | "all" | "pending";

/**
 * Everyone the server did not resolve to `offline`. Idle and do-not-disturb
 * both count as "around": the tab answers "who could I talk to", and someone
 * who stepped away for coffee or asked not to be pinged is still here in the
 * way that matters. An invisible friend never reaches this function as
 * anything but `offline` — the server's status type cannot carry `invisible`.
 */
export function onlineFriends(friends: readonly Friend[]): Friend[] {
  return friends.filter((friend) => friend.status !== "offline");
}

/**
 * What the Pending tab's badge counts: requests waiting on YOU. Outgoing ones
 * are deliberately excluded — a badge is a call to action, and there is no
 * action to take on a request you already sent.
 */
export function pendingActionCount(
  response: Pick<FriendsResponse, "incoming">,
): number {
  return response.incoming.length;
}

/**
 * Online first, then the rest — within each half the server's alphabetical
 * order is preserved. Only the All tab uses this; the Online tab is already
 * homogeneous.
 */
export function sortOnlineFirst(friends: readonly Friend[]): Friend[] {
  const online: Friend[] = [];
  const offline: Friend[] = [];
  for (const friend of friends) {
    (friend.status === "offline" ? offline : online).push(friend);
  }
  return [...online, ...offline];
}

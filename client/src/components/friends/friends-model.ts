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
 * What the Pending tab's badge counts: everything waiting on YOU.
 *
 * Outgoing requests are deliberately excluded — a badge is a call to action,
 * and there is no action to take on a request you already sent.
 *
 * Depoimentos waiting to be published or refused ARE counted, because they are
 * the same errand answered on the same tab with the same two buttons. See
 * `waitingOnYou` in the depoimentos model, which is where that argument lives
 * and where the front door's badge gets it from.
 */
export function pendingActionCount(
  response: Pick<FriendsResponse, "incoming">,
  pendingDepoimentos: readonly unknown[] = [],
): number {
  return response.incoming.length + pendingDepoimentos.length;
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

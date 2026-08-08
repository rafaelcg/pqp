import type { FriendsResponse, UserStatus } from "@pqp/shared";

/**
 * The profile card's logic, out of the component so the state machine is
 * testable without a DOM or a network. Every function here is pure.
 *
 * This is the web half of the mapping iOS already ships in
 * `ios/pqp/Sources/Home/UserProfileSheet.swift` — deliberately the same six
 * states and the same precedence, so the two clients cannot disagree about
 * what "you and this person" means.
 */

/** The person a card is opened on. */
export interface ProfileSubject {
  id: string;
  displayName: string;
  /**
   * `name#1234`. Absent for accounts that predate handles, in which case the
   * line is simply not drawn.
   */
  tag: string | null;
  avatarUrl: string | null;
  /**
   * Presence the *caller* already knows (the members panel resolves it
   * server-side). Never guessed: there is no per-user presence endpoint, so
   * `null` means "unknown" and must draw nothing rather than "offline" —
   * claiming somebody is away because we failed to look is worse than saying
   * nothing.
   */
  status?: UserStatus | null;
}

/**
 * Where you stand with someone, as the three lists in `GET /api/friends` plus
 * the block list describe it.
 *
 * One union rather than four booleans because the states are exclusive and the
 * buttons differ per state — code that reasons about `isFriend && !isBlocked
 * && !hasOutgoing` grows a wrong combination eventually.
 */
export type FriendshipState =
  /** You, looking at yourself. Every relationship action is meaningless. */
  | "self"
  /**
   * You blocked them. Outranks everything else, including friendship: the
   * schema's trigger deletes the friend row when a block lands, so the two
   * cannot legitimately coexist — and if a stale read says they do, the block
   * is the fact with consequences.
   */
  | "blocked"
  | "friends"
  /** They asked you. The one state with a one-click answer. */
  | "pendingIncoming"
  /** You asked them. Nothing to do but wait, or take it back. */
  | "pendingOutgoing"
  | "none";

/** The single relationship button the card offers for a state. */
export type ProfilePrimaryAction =
  | "addFriend"
  | "acceptRequest"
  | "cancelRequest"
  /**
   * Not a verb: the friends state's primary reads "Friends ✓" and does
   * nothing. Unfriending is real and silent — the other side is never told —
   * so it lives in the overflow menu where a mis-click cannot reach it.
   */
  | "alreadyFriends"
  | "unblock"
  /** Your own profile: there is no relationship to act on. */
  | "none";

/**
 * Resolve the one state that applies. Order matters and is stated above:
 * self, then blocked, then friends, then the two pending directions.
 */
export function resolveFriendshipState(
  userId: string,
  selfId: string | null,
  friends: FriendsResponse,
  blockedIds: ReadonlySet<string>,
): FriendshipState {
  if (selfId && selfId === userId) {
    return "self";
  }
  if (blockedIds.has(userId)) {
    return "blocked";
  }
  if (friends.friends.some((one) => one.id === userId)) {
    return "friends";
  }
  if (friends.incoming.some((one) => one.id === userId)) {
    return "pendingIncoming";
  }
  if (friends.outgoing.some((one) => one.id === userId)) {
    return "pendingOutgoing";
  }
  return "none";
}

export function primaryAction(state: FriendshipState): ProfilePrimaryAction {
  switch (state) {
    case "self":
      return "none";
    case "blocked":
      return "unblock";
    case "friends":
      return "alreadyFriends";
    case "pendingIncoming":
      return "acceptRequest";
    case "pendingOutgoing":
      return "cancelRequest";
    case "none":
      return "addFriend";
  }
}

/**
 * Whether the primary does anything when clicked. "Friends ✓" is a statement,
 * not a button — it is drawn as the primary because that is where the eye goes
 * to learn where you stand.
 */
export function primaryIsInert(action: ProfilePrimaryAction): boolean {
  return action === "alreadyFriends" || action === "none";
}

/**
 * Whether the action needs confirming. Cancelling a request is the only
 * destructive thing reachable from the primary, and it is silent on the other
 * side — so a mis-click is invisible to them and uncorrectable by them.
 */
export function needsConfirmation(action: ProfilePrimaryAction): boolean {
  return action === "cancelRequest";
}

/**
 * Declining is offered *beside* accepting rather than behind the overflow — a
 * request you did not want should cost one click, and it is silent, so the
 * only way it can go wrong is by being hard to reach.
 */
export function offersDecline(state: FriendshipState): boolean {
  return state === "pendingIncoming";
}

/**
 * DMs to yourself are not a thing the server models, and a DM to somebody you
 * blocked would be a message you cannot see the answer to. Everything else is
 * offered — a refusal is still possible (`dmPrivacy`) and the server's wording
 * is what gets shown when it happens.
 */
export function canMessage(state: FriendshipState): boolean {
  return state !== "self" && state !== "blocked";
}

export function canBlock(state: FriendshipState): boolean {
  return state !== "self" && state !== "blocked";
}

export function canRemoveFriend(state: FriendshipState): boolean {
  return state === "friends";
}

export function canReport(state: FriendshipState): boolean {
  return state !== "self";
}

/**
 * Presence to draw. A friend's status comes from the friends list, which is
 * the freshest thing we have; anything else falls back to whatever the caller
 * knew. `null` means "we do not know" and must draw nothing.
 */
export function resolvePresence(
  userId: string,
  state: FriendshipState,
  friends: FriendsResponse,
  fallback: UserStatus | null | undefined,
): UserStatus | null {
  if (state === "friends") {
    const friend = friends.friends.find((one) => one.id === userId);
    if (friend) {
      return friend.status;
    }
  }
  return fallback ?? null;
}

/** When the two of you became friends, for the "Friends since" line. */
export function friendsSince(
  userId: string,
  friends: FriendsResponse,
): string | null {
  return friends.friends.find((one) => one.id === userId)?.friendsSince ?? null;
}

// ---------------------------------------------------------------- placement

/** Clearance from the window edge, and from the anchor. */
export const CARD_GAP = 8;

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
}

/**
 * Anchor-positioned the way Discord's card is: beside the name if there is
 * room, flipped to its other side if not, and clamped so the card is never
 * partly off-screen.
 *
 * Pure and here rather than in the component because the failure mode is
 * silent — a card placed at a negative `top` is invisible, not broken-looking
 * — and geometry is exactly the thing worth pinning with numbers.
 */
export function placeCard(
  anchor: Rect,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const fitsRight = viewport.width - anchor.right - CARD_GAP >= card.width;
  const fitsLeft = anchor.left - CARD_GAP - card.width >= 0;
  const left = fitsRight
    ? anchor.right + CARD_GAP
    : fitsLeft
      ? anchor.left - CARD_GAP - card.width
      : // Neither side fits (a narrow window): sit over the anchor, but inside
        // the window — never hanging off an edge.
        Math.max(CARD_GAP, viewport.width - card.width - CARD_GAP);

  // Top-aligned with the anchor, pulled up only as far as it must be to fit.
  const top = Math.max(
    CARD_GAP,
    Math.min(anchor.top, viewport.height - card.height - CARD_GAP),
  );
  return { left, top };
}

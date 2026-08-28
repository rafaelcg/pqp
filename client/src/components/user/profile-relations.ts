import {
  canModerateMember,
  type FriendsResponse,
  type MemberRole,
  type UserStatus,
} from "@pqp/shared";

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
  /** Handle used for `@username` mentions. Optional when the caller has none. */
  username?: string | null;
  /** Painted roles this person holds in the current server, if known. */
  roleIds?: string[];
  /** Rank column: owner / admin chip, not a painted role. */
  rank?: MemberRole | null;
  /**
   * The server nickname, when the opener knows it (the members panel does).
   * Prefills the card's Change-nickname prompt; absent means "unknown", not
   * "none", so the prompt starts blank rather than wrong.
   */
  nickname?: string | null;
}

/** Painted roles the card can list. `@everyone` is filtered out at render. */
export interface ProfileRoleChip {
  id: string;
  name: string;
  color: string | null;
  position: number;
  isEveryone: boolean;
  /** Seeded Admin is rank, not a cargo chip. */
  systemKey?: "everyone" | "admin" | null;
}

/**
 * Custom cargos to list under the name. Seeded Admin is the shield next to
 * the name, not a pill on its own row.
 */
export function cardRoleChips(
  roles: readonly ProfileRoleChip[] | undefined,
  roleIds: readonly string[] | undefined,
): ProfileRoleChip[] {
  if (!roles?.length || !roleIds?.length) {
    return [];
  }
  const held = new Set(roleIds);
  return roles
    .filter(
      (role) =>
        held.has(role.id) && !role.isEveryone && role.systemKey !== "admin",
    )
    .slice()
    .sort((a, b) => b.position - a.position);
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

/**
 * Whether to offer the phone: exactly the set that may be messaged, and
 * deliberately not a narrower one.
 *
 * A DM call is a conversation plus a ring, so the button walks the same two
 * server gates the Message button walks (`POST /api/dms` → `assertReachable`,
 * then the ring's own `resolveRingableConversation`). That makes the card's
 * rule "hide it only where the client can be SURE it cannot ring", and there
 * are two such cases, both already covered by `canMessage`:
 *
 *  - YOURSELF. The server has no self-pair and the card replaces the whole
 *    action row with "this is you" anyway.
 *  - SOMEBODY YOU BLOCKED. `isDmSendBlocked` refuses both the conversation and
 *    the `call-ring` frame, so the phone provably rings nowhere. The DM list
 *    hides its own phone on a blocked row for this exact reason.
 *
 * And the cases it deliberately does NOT hide, each because the client's
 * evidence is worse than the server's:
 *
 *  - NOT A FRIEND. `dm_privacy` defaults to `server_members`, and seeing this
 *    card at all normally means you share a server. Friendship is not the rule.
 *  - DMs RESTRICTED (`dm_privacy = 'nobody'`, which is also every character
 *    account's setting). The viewer is never told another person's setting —
 *    that is the point of it — so the card cannot know. The server refuses with
 *    its own wording and the card prints it in the error line, which is the
 *    same treatment Message has always had.
 *  - OFFLINE. Presence here is `null` (unknown) for anybody who is not a
 *    friend, so gating on it would hide the phone from most people over a fact
 *    we never looked up. It is also not true that calling an offline person
 *    does nothing: an unanswered ring is written into the conversation as a
 *    missed-call message, which is exactly what a phone is for. DND is handled
 *    server-side, quietly, and does not belong in a stranger's UI either.
 *  - ALREADY IN A CALL. Starting one is a MOVE in this app — the server drops
 *    the socket's previous peer on the new join, the same as clicking another
 *    voice channel — so the honest answer is to let it move you. The one thing
 *    worth not doing is re-joining the call you are already in, and that is
 *    handled where the app knows the channel id, not here.
 */
export function canCall(state: FriendshipState): boolean {
  return canMessage(state);
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

// --------------------------------------------------------------- moderation

/**
 * What the card knows about the server it was opened in — nothing when it was
 * opened from a conversation, which has no moderators at all.
 *
 * WHY THE CARD MODERATES NOW. Every moderation action lived on the members
 * panel: a moderator reading a message that needed acting on had to open the
 * roster, find the person in it, and act at a distance from the thing they were
 * reacting to. The person's name is right there in the transcript and it already
 * opens a card. This puts the ladder where the evidence is.
 *
 * The card stays a profile card, not a console: these ride in the SAME overflow
 * menu Block and Report already ride in, for the reason stated on that menu —
 * a punitive button the size of "Add friend" makes a profile read as a charge
 * sheet.
 */
export interface ProfileModerationContext {
  serverId: string;
  /** The viewer's role in THIS server. */
  actorRole: MemberRole;
  /**
   * Roles of this server's members, by id. Handed in from the roster the app
   * already fetches for mention autocomplete, so the card costs no request.
   *
   * A person MISSING from this map is a person whose rank is unknown, which is
   * treated as "offer nothing" rather than as "not a member" — see below.
   */
  memberRoles: ReadonlyMap<string, MemberRole>;
  /**
   * Who currently has a live timeout in this server — ids only.
   *
   * Ids and not the timeouts themselves because the card asks one question of
   * this ("is there one to end?") and the members panel asks all the others
   * (who issued it, why, when it ends) from its own copy. Handing the card the
   * full records would give it a second, staler source for the line the panel
   * already draws well.
   */
  timedOutUserIds: ReadonlySet<string>;
  /** Something was issued or lifted; the app re-reads the list. */
  onModerated: () => void;
}

/** The three rungs the card offers, in ladder order. */
export type ProfileModerationAction = "timeout" | "endTimeout" | "kick" | "ban";

/**
 * Which rungs to draw. Empty for a conversation, for a non-manager, and for
 * anybody the rank rule protects — `canModerateMember` is the single judge of
 * that last one, shared with iOS and mirroring the server's `requireOutranked`,
 * so this surface cannot offer something the API will refuse.
 *
 * UNKNOWN RANK OFFERS NOTHING. `canModerateMember` deliberately allows a `null`
 * target so a *pre-emptive ban* of a non-member stays possible, but that is not
 * this surface: a card opened on a name in a server channel is about somebody in
 * that server, and if the roster has not arrived yet the honest answer is to
 * draw no menu rather than to offer a kick that would 404. The panel is where
 * you ban somebody who is not here.
 */
export function moderationActions(
  subjectId: string,
  currentUserId: string | null,
  context: ProfileModerationContext | null,
): ProfileModerationAction[] {
  if (!context) {
    return [];
  }
  const targetRole = context.memberRoles.get(subjectId);
  if (!targetRole) {
    return [];
  }
  const allowed = canModerateMember("timeout", {
    actorRole: context.actorRole,
    actorId: currentUserId,
    targetRole,
    targetId: subjectId,
  });
  if (!allowed) {
    return [];
  }
  // A live timeout replaces the offer to issue one: two rows that both say
  // "timeout" is how a moderator double-sanctions somebody by accident. Lifting
  // is not destructive, so it needs no confirmation and sits first.
  return context.timedOutUserIds.has(subjectId)
    ? ["endTimeout", "kick", "ban"]
    : ["timeout", "kick", "ban"];
}

/**
 * Whether an action takes something away that the person cannot get back by
 * themselves — which is the whole test for "confirm this".
 *
 * A timeout expires on its own and can be lifted in one tap, so it is confirmed
 * by the composer it needs anyway (a duration has to be chosen) rather than by a
 * second "are you sure". Lifting one takes nothing away. A kick and a ban both
 * end a membership.
 */
export function moderationNeedsConfirmation(
  action: ProfileModerationAction,
): boolean {
  return action === "kick" || action === "ban";
}

/** The owner-only rank change a card may offer: promote a member, demote an admin. */
export type ProfileRoleChange = "promote" | "demote";

/**
 * The one rank change the card may offer for this person, or null.
 *
 * Owner-only and never yourself — the rule the members panel's `actionsFor`
 * applies, and the one the server enforces with `requireOwner` on
 * `PATCH /api/servers/:id/members/:userId`. An unknown rank offers nothing,
 * the rule `moderationActions` already argues: a card that guesses offers an
 * action that 404s.
 *
 * NOT PART OF `moderationActions` on purpose. That list is the enforcement
 * ladder, ordered reversible-first so the menu teaches it; a role change
 * sanctions nobody and is not a rung. Deriving it separately is what lets the
 * ladder's tests stay exactly as they are.
 */
export function roleChangeFor(
  subjectId: string,
  currentUserId: string | null,
  context: ProfileModerationContext | null,
): ProfileRoleChange | null {
  if (
    !context ||
    context.actorRole !== "owner" ||
    subjectId === currentUserId
  ) {
    return null;
  }
  const targetRole = context.memberRoles.get(subjectId);
  if (targetRole === "member") {
    return "promote";
  }
  if (targetRole === "admin") {
    return "demote";
  }
  return null;
}

// ---------------------------------------------------------- profile about

/**
 * The three optional blocks below the medals. A card that has more than one
 * shows them as an iOS segmented control rather than a stack: stacking is
 * what pushed Comunidades off a short window, and three accordions would
 * spend the same space on chevrons. One pane at a time, leftover height.
 */
export type ProfileAboutTab = "depoimentos" | "connections" | "communities";

export function profileAboutTabs(input: {
  depoimentoCount: number;
  connectionCount: number;
  communityCount: number;
}): ProfileAboutTab[] {
  const tabs: ProfileAboutTab[] = [];
  if (input.depoimentoCount > 0) {
    tabs.push("depoimentos");
  }
  if (input.connectionCount > 0) {
    tabs.push("connections");
  }
  if (input.communityCount > 0) {
    tabs.push("communities");
  }
  return tabs;
}

export function activeProfileAboutTab(
  tabs: readonly ProfileAboutTab[],
  picked: ProfileAboutTab | null,
): ProfileAboutTab | null {
  if (tabs.length === 0) {
    return null;
  }
  if (picked && tabs.includes(picked)) {
    return picked;
  }
  // Contas is the default open pane when this person has any. The segment
  // order stays Depoimentos / Contas / Comunidades; only the initial pick
  // moves, so a card with quotes and rooms but no accounts still opens on
  // depoimentos.
  if (tabs.includes("connections")) {
    return "connections";
  }
  return tabs[0]!;
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

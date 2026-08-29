import type { Friend, FriendRequestEntry, FriendsResponse } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import {
  canBlock,
  canCall,
  canMessage,
  canRemoveFriend,
  canReport,
  friendsSince,
  needsConfirmation,
  offersDecline,
  placeCard,
  primaryAction,
  primaryIsInert,
  resolveFriendshipState,
  resolvePresence,
  moderationActions,
  moderationNeedsConfirmation,
  roleChangeFor,
  cardRoleChips,
  profileAboutTabs,
  activeProfileAboutTab,
  type FriendshipState,
  type ProfileModerationContext,
  type ProfileRoleChip,
} from "./profile-relations";

const ME = "00000000-0000-4000-8000-000000000000";
const THEM = "11111111-1111-4111-8111-111111111111";

function friend(id: string, status: Friend["status"] = "online"): Friend {
  return {
    id,
    displayName: "Them",
    username: "them",
    tag: "them#0001",
    avatarUrl: null,
    status,
    friendsSince: "2026-01-05T00:00:00.000Z",
  };
}

function request(id: string): FriendRequestEntry {
  return {
    id,
    displayName: "Them",
    username: "them",
    tag: "them#0001",
    avatarUrl: null,
    requestedAt: "2026-02-01T00:00:00.000Z",
  };
}

const EMPTY: FriendsResponse = { friends: [], incoming: [], outgoing: [] };
const NOBODY_BLOCKED: ReadonlySet<string> = new Set<string>();

describe("resolveFriendshipState", () => {
  it("calls your own profile self before anything else", () => {
    // Even with a (nonsensical) friend row for yourself, self wins.
    expect(
      resolveFriendshipState(
        ME,
        ME,
        { ...EMPTY, friends: [friend(ME)] },
        new Set([ME]),
      ),
    ).toBe("self");
  });

  it("lets a block outrank a stale friendship", () => {
    // The schema's trigger deletes the friend row when a block lands, so this
    // pair cannot legitimately coexist — and if a stale read says they do, the
    // block is the fact with consequences.
    expect(
      resolveFriendshipState(
        THEM,
        ME,
        { ...EMPTY, friends: [friend(THEM)] },
        new Set([THEM]),
      ),
    ).toBe("blocked");
  });

  it("reads the three lists in order", () => {
    expect(
      resolveFriendshipState(
        THEM,
        ME,
        { ...EMPTY, friends: [friend(THEM)] },
        NOBODY_BLOCKED,
      ),
    ).toBe("friends");
    expect(
      resolveFriendshipState(
        THEM,
        ME,
        { ...EMPTY, incoming: [request(THEM)] },
        NOBODY_BLOCKED,
      ),
    ).toBe("pendingIncoming");
    expect(
      resolveFriendshipState(
        THEM,
        ME,
        { ...EMPTY, outgoing: [request(THEM)] },
        NOBODY_BLOCKED,
      ),
    ).toBe("pendingOutgoing");
  });

  it("is `none` for a stranger, and for a signed-out reader", () => {
    expect(resolveFriendshipState(THEM, ME, EMPTY, NOBODY_BLOCKED)).toBe("none");
    // No self id yet (still booting): a stranger, not accidentally yourself.
    expect(resolveFriendshipState(THEM, null, EMPTY, NOBODY_BLOCKED)).toBe(
      "none",
    );
  });
});

describe("primaryAction", () => {
  it("maps every state to exactly one button", () => {
    const mapping: Record<FriendshipState, string> = {
      self: "none",
      blocked: "unblock",
      friends: "alreadyFriends",
      pendingIncoming: "acceptRequest",
      pendingOutgoing: "cancelRequest",
      none: "addFriend",
    };
    for (const [state, expected] of Object.entries(mapping)) {
      expect(primaryAction(state as FriendshipState)).toBe(expected);
    }
  });

  it("makes only the two statement-shaped primaries inert", () => {
    expect(primaryIsInert(primaryAction("friends"))).toBe(true);
    expect(primaryIsInert(primaryAction("self"))).toBe(true);
    expect(primaryIsInert(primaryAction("none"))).toBe(false);
    expect(primaryIsInert(primaryAction("pendingIncoming"))).toBe(false);
    expect(primaryIsInert(primaryAction("blocked"))).toBe(false);
  });

  it("confirms only the destructive primary", () => {
    // Adding, accepting and unblocking are cheap and reversible. Cancelling is
    // silent on the other side, so a mis-click is uncorrectable by them.
    expect(needsConfirmation(primaryAction("pendingOutgoing"))).toBe(true);
    expect(needsConfirmation(primaryAction("none"))).toBe(false);
    expect(needsConfirmation(primaryAction("pendingIncoming"))).toBe(false);
    expect(needsConfirmation(primaryAction("blocked"))).toBe(false);
  });

  it("offers Decline beside Accept, and nowhere else", () => {
    expect(offersDecline("pendingIncoming")).toBe(true);
    for (const state of [
      "self",
      "blocked",
      "friends",
      "pendingOutgoing",
      "none",
    ] as FriendshipState[]) {
      expect(offersDecline(state)).toBe(false);
    }
  });
});

describe("secondary affordances", () => {
  it("never offers to message yourself or somebody you blocked", () => {
    expect(canMessage("self")).toBe(false);
    expect(canMessage("blocked")).toBe(false);
    expect(canMessage("none")).toBe(true);
    expect(canMessage("friends")).toBe(true);
  });

  it("offers the phone exactly where it offers the message", () => {
    // One rule, not two: a DM call is a conversation plus a ring, and both
    // halves are refused by the server in the same two cases the card can be
    // sure about. See `canCall` for the cases it deliberately does not gate —
    // offline, not a friend, DMs restricted, already in another call.
    for (const state of [
      "self",
      "blocked",
      "friends",
      "pendingIncoming",
      "pendingOutgoing",
      "none",
    ] as FriendshipState[]) {
      expect(canCall(state)).toBe(canMessage(state));
    }
    expect(canCall("self")).toBe(false);
    expect(canCall("blocked")).toBe(false);
    expect(canCall("none")).toBe(true);
  });

  it("never offers to block yourself or to re-block", () => {
    expect(canBlock("self")).toBe(false);
    expect(canBlock("blocked")).toBe(false);
    expect(canBlock("friends")).toBe(true);
  });

  it("keeps unfriending out of everything but the friends state", () => {
    expect(canRemoveFriend("friends")).toBe(true);
    expect(canRemoveFriend("pendingOutgoing")).toBe(false);
    expect(canRemoveFriend("none")).toBe(false);
  });

  it("offers report on everyone but yourself", () => {
    expect(canReport("self")).toBe(false);
    expect(canReport("blocked")).toBe(true);
    expect(canReport("none")).toBe(true);
  });
});

describe("resolvePresence", () => {
  it("prefers the friends list, which is the freshest thing we have", () => {
    const data = { ...EMPTY, friends: [friend(THEM, "dnd")] };
    expect(resolvePresence(THEM, "friends", data, "online")).toBe("dnd");
  });

  it("falls back to what the caller knew", () => {
    expect(resolvePresence(THEM, "none", EMPTY, "idle")).toBe("idle");
  });

  it("answers null when nobody knows — never `offline`", () => {
    // Drawing "offline" for an unknown presence claims somebody is away
    // because we failed to look, which is worse than saying nothing.
    expect(resolvePresence(THEM, "none", EMPTY, null)).toBeNull();
    expect(resolvePresence(THEM, "none", EMPTY, undefined)).toBeNull();
    // Friends state but no matching row (a snapshot mid-refresh) is still
    // "unknown" rather than a guess.
    expect(resolvePresence(THEM, "friends", EMPTY, null)).toBeNull();
  });
});

describe("friendsSince", () => {
  it("is the friend row's timestamp, or nothing", () => {
    expect(friendsSince(THEM, { ...EMPTY, friends: [friend(THEM)] })).toBe(
      "2026-01-05T00:00:00.000Z",
    );
    expect(friendsSince(THEM, EMPTY)).toBeNull();
  });
});

describe("placeCard", () => {
  // Mirrors the component's CARD_WIDTH — the strip of action tiles and the
  // full-width relationship pill are budgeted against this number.
  const CARD = { width: 320, height: 320 };
  const VIEWPORT = { width: 1280, height: 800 };

  it("sits to the right of the anchor when there is room", () => {
    const at = placeCard(
      { left: 100, right: 200, top: 300, bottom: 320 },
      CARD,
      VIEWPORT,
    );
    expect(at.left).toBe(208);
    expect(at.top).toBe(300);
  });

  it("flips to the left when the right edge is too close", () => {
    const at = placeCard(
      { left: 1100, right: 1200, top: 100, bottom: 120 },
      CARD,
      VIEWPORT,
    );
    expect(at.left).toBe(1100 - 8 - 320);
  });

  it("stays inside a window too narrow for either side", () => {
    const at = placeCard(
      { left: 40, right: 160, top: 100, bottom: 120 },
      CARD,
      { width: 390, height: 844 },
    );
    expect(at.left).toBeGreaterThanOrEqual(8);
    expect(at.left + CARD.width).toBeLessThanOrEqual(390 - 8);
  });

  it("pulls a card anchored near the bottom up until it fits", () => {
    const at = placeCard(
      { left: 100, right: 200, top: 760, bottom: 780 },
      CARD,
      VIEWPORT,
    );
    expect(at.top).toBe(800 - 320 - 8);
    expect(at.top).toBeGreaterThanOrEqual(8);
  });

  it("never places a card off the top of a short window", () => {
    const at = placeCard(
      { left: 100, right: 200, top: 20, bottom: 40 },
      CARD,
      { width: 1280, height: 300 },
    );
    expect(at.top).toBe(8);
  });
});

/**
 * The card's moderation menu.
 *
 * The rank rule itself is proved in `packages/shared/src/friends.test.ts`; this
 * covers what is specific to THIS surface — that a conversation offers nothing,
 * that an unknown rank offers nothing, and that a live timeout swaps "issue" for
 * "end" rather than showing both.
 */
describe("moderationActions", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";

  function context(
    overrides: Partial<ProfileModerationContext> = {},
  ): ProfileModerationContext {
    return {
      serverId: "33333333-3333-4333-8333-333333333333",
      actorRole: "owner",
      memberRoles: new Map([
        [ME, "owner"],
        [THEM, "member"],
        [OTHER, "admin"],
      ]),
      timedOutUserIds: new Set<string>(),
      onModerated: () => {},
      ...overrides,
    };
  }

  it("offers the whole ladder to an owner, reversible rung first", () => {
    expect(moderationActions(THEM, ME, context())).toEqual([
      "timeout",
      "kick",
      "ban",
    ]);
  });

  /**
   * A conversation has no moderators — the same rule that keeps a server
   * timeout out of a DM. `null` is how the app says "not in a server", and it is
   * the first thing this surface checks.
   */
  it("offers nothing when there is no server", () => {
    expect(moderationActions(THEM, ME, null)).toEqual([]);
  });

  it("offers nothing to a plain member", () => {
    expect(
      moderationActions(THEM, ME, context({ actorRole: "member" })),
    ).toEqual([]);
  });

  it("offers nothing against a peer admin", () => {
    expect(
      moderationActions(OTHER, ME, context({ actorRole: "admin" })),
    ).toEqual([]);
  });

  it("offers nothing against the owner", () => {
    expect(
      moderationActions(ME, OTHER, context({ actorRole: "admin" })),
    ).toEqual([]);
  });

  /**
   * The pre-emptive ban lives on the members panel, not here: a card opened on a
   * name in a channel is about somebody in this server, and if the roster has
   * not arrived a kick offered against them would 404. Drawing nothing is the
   * honest answer, and it is why this differs from `canModerateMember`, which
   * allows a null target on purpose.
   */
  it("offers nothing when the person's rank is not known yet", () => {
    expect(
      moderationActions(THEM, ME, context({ memberRoles: new Map() })),
    ).toEqual([]);
  });

  it("swaps issuing a timeout for ending one, never both", () => {
    const actions = moderationActions(
      THEM,
      ME,
      context({ timedOutUserIds: new Set([THEM]) }),
    );
    expect(actions).toEqual(["endTimeout", "kick", "ban"]);
    expect(actions).not.toContain("timeout");
  });
});

describe("moderationNeedsConfirmation", () => {
  it("confirms only what ends a membership", () => {
    expect(moderationNeedsConfirmation("kick")).toBe(true);
    expect(moderationNeedsConfirmation("ban")).toBe(true);
    // A timeout is confirmed by the composer it needs anyway — a duration has to
    // be chosen — and lifting one takes nothing away at all.
    expect(moderationNeedsConfirmation("timeout")).toBe(false);
    expect(moderationNeedsConfirmation("endTimeout")).toBe(false);
  });
});

/**
 * The owner-only rank change, kept out of the ladder on purpose (see
 * `roleChangeFor`). This covers who may be offered it and who may not.
 */
describe("roleChangeFor", () => {
  it("never offers promote or demote; cargos are ticked instead", () => {
    expect(
      roleChangeFor("a", "b", {
        serverId: "s",
        actorRole: "owner",
        memberRoles: new Map([["a", "member"]]),
        timedOutUserIds: new Set(),
        onModerated: () => {},
      }),
    ).toBeNull();
  });
});

describe("cardRoleChips", () => {
  const admin: ProfileRoleChip = {
    id: "admin",
    name: "Admin",
    color: null,
    position: 50,
    isEveryone: false,
    systemKey: "admin",
  };
  const everyone: ProfileRoleChip = {
    id: "everyone",
    name: "@everyone",
    color: null,
    position: 0,
    isEveryone: true,
    systemKey: "everyone",
  };
  const vip: ProfileRoleChip = {
    id: "vip",
    name: "VIP",
    color: "#ff00aa",
    position: 10,
    isEveryone: false,
    systemKey: null,
  };
  const mods: ProfileRoleChip = {
    id: "mods",
    name: "Mods",
    color: "#00aaff",
    position: 20,
    isEveryone: false,
    systemKey: null,
  };

  it("drops @everyone and Owner, keeps Admin and custom cargos", () => {
    expect(
      cardRoleChips(
        [everyone, admin, vip, mods],
        ["everyone", "admin", "vip", "mods"],
      ).map((role) => role.id),
    ).toEqual(["admin", "mods", "vip"]);
  });

  it("is empty when the person only holds @everyone", () => {
    expect(cardRoleChips([everyone, admin], ["everyone"])).toEqual([]);
  });
});

describe("profileAboutTabs", () => {
  it("omits empty blocks and keeps depoimentos first", () => {
    expect(
      profileAboutTabs({
        depoimentoCount: 2,
        connectionCount: 0,
        communityCount: 4,
      }),
    ).toEqual(["depoimentos", "communities"]);
  });

  it("is empty when there is nothing to show", () => {
    expect(
      profileAboutTabs({
        depoimentoCount: 0,
        connectionCount: 0,
        communityCount: 0,
      }),
    ).toEqual([]);
  });
});

describe("activeProfileAboutTab", () => {
  it("opens Contas by default when that pane exists", () => {
    expect(
      activeProfileAboutTab(
        ["depoimentos", "connections", "communities"],
        null,
      ),
    ).toBe("connections");
  });

  it("falls back to the first tab when there are no accounts", () => {
    expect(
      activeProfileAboutTab(["depoimentos", "communities"], null),
    ).toBe("depoimentos");
  });

  it("falls back when the pick is gone", () => {
    expect(
      activeProfileAboutTab(["connections", "communities"], "depoimentos"),
    ).toBe("connections");
  });

  it("keeps a pick that is still present", () => {
    expect(
      activeProfileAboutTab(["depoimentos", "communities"], "communities"),
    ).toBe("communities");
  });
});

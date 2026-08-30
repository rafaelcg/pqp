import { describe, expect, it } from "vitest";
import {
  highestRoleColor,
  identityMarks,
  rankBadges,
  usernameFromTag,
} from "./author-display";

const roles = [
  { id: "low", color: "#111111", position: 1 },
  { id: "high", color: "#ff00aa", position: 5 },
  { id: "plain", color: null, position: 9 },
];

describe("highestRoleColor", () => {
  it("picks the highest position that has a colour", () => {
    expect(highestRoleColor(["low", "high", "plain"], roles)).toBe("#ff00aa");
  });

  it("skips a higher role with no colour", () => {
    expect(highestRoleColor(["low", "plain"], roles)).toBe("#111111");
  });

  it("returns null when nothing held is painted", () => {
    expect(highestRoleColor(["plain"], roles)).toBeNull();
    expect(highestRoleColor([], roles)).toBeNull();
    expect(highestRoleColor(undefined, roles)).toBeNull();
  });
});

describe("identityMarks", () => {
  it("is empty for an ordinary member", () => {
    expect(identityMarks({ rank: "member" })).toEqual([]);
  });

  it("gives the owner a crown and an admin a shield", () => {
    expect(identityMarks({ rank: "owner" })).toEqual(["owner"]);
    expect(identityMarks({ rank: "admin" })).toEqual(["admin"]);
  });

  it("marks a character as a bot, including next to rank", () => {
    expect(identityMarks({ rank: "member", isCharacter: true })).toEqual([
      "bot",
    ]);
    expect(identityMarks({ rank: "admin", isCharacter: true })).toEqual([
      "admin",
      "bot",
    ]);
  });

  it("gives a webhook none of these, even if the payload carried rank", () => {
    expect(
      identityMarks({ rank: "owner", isCharacter: true, isWebhook: true }),
    ).toEqual([]);
  });

  it("hides the crown when the Owner cargo has the badge off", () => {
    expect(
      identityMarks({ rank: "owner", ownerBadge: false, adminBadge: false }),
    ).toEqual([]);
  });

  it("shows the Admin shield from the Admin cargo, not from rank", () => {
    expect(
      identityMarks({ rank: "admin", ownerBadge: false, adminBadge: true }),
    ).toEqual(["admin"]);
    expect(
      identityMarks({ rank: "admin", ownerBadge: false, adminBadge: false }),
    ).toEqual([]);
  });

  it("picks the highest staff cargo, then VIP, then a bot mark", () => {
    expect(
      identityMarks({
        rank: "member",
        managerBadge: true,
        moderatorBadge: true,
        vipBadge: true,
      }),
    ).toEqual(["manager"]);
    expect(
      identityMarks({
        rank: "member",
        moderatorBadge: true,
        vipBadge: true,
      }),
    ).toEqual(["moderator"]);
    expect(identityMarks({ rank: "member", vipBadge: true })).toEqual(["vip"]);
    expect(
      identityMarks({ rank: "member", vipBadge: true, isCharacter: true }),
    ).toEqual(["vip", "bot"]);
  });
});

describe("rankBadges", () => {
  const roles = [
    { id: "owner", systemKey: "owner", showBadge: true },
    { id: "admin", systemKey: "admin", showBadge: true },
    { id: "mgr", name: "Manager", systemKey: "manager" },
    { id: "mod", name: "Moderator", systemKey: "moderator" },
    { id: "vip", name: "VIP", systemKey: "vip" },
  ];

  it("reads the Owner and Admin cargos from held ids", () => {
    expect(rankBadges(["owner", "admin"], roles)).toEqual({
      ownerBadge: true,
      adminBadge: true,
      managerBadge: false,
      moderatorBadge: false,
      vipBadge: false,
    });
  });

  it("hides the crown when showBadge is off", () => {
    expect(
      rankBadges(["owner"], [{ id: "owner", systemKey: "owner", showBadge: false }]),
    ).toEqual({
      ownerBadge: false,
      adminBadge: false,
      managerBadge: false,
      moderatorBadge: false,
      vipBadge: false,
    });
  });

  it("flags manager, moderator and a VIP cargo by system key", () => {
    expect(rankBadges(["mgr", "mod", "vip"], roles)).toEqual({
      ownerBadge: false,
      adminBadge: false,
      managerBadge: true,
      moderatorBadge: true,
      vipBadge: true,
    });
  });

  it("still flags a homemade VIP by name before the ladder claims it", () => {
    expect(
      rankBadges(["old"], [{ id: "old", name: "VIP", systemKey: null }]),
    ).toEqual({
      ownerBadge: false,
      adminBadge: false,
      managerBadge: false,
      moderatorBadge: false,
      vipBadge: true,
    });
  });
});

describe("usernameFromTag", () => {
  it("takes the handle before the discriminator", () => {
    expect(usernameFromTag("dev_user#8692")).toBe("dev_user");
  });

  it("rejects a missing or empty tag", () => {
    expect(usernameFromTag(null)).toBeNull();
    expect(usernameFromTag("")).toBeNull();
    expect(usernameFromTag("#1234")).toBeNull();
    expect(usernameFromTag("nobody")).toBeNull();
  });
});

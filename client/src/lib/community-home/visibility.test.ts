import { describe, expect, it } from "vitest";
import { lockedPostSummary } from "./posts";
import { resolveCommunityHomeViewer } from "./viewer";
import {
  canViewHomePostFull,
  homePostIsLocked,
  isPostLockedForViewer,
} from "./visibility";

describe("canViewHomePostFull / homePostIsLocked", () => {
  it("free posts are open to every role", () => {
    for (const role of ["owner", "members", "vip"] as const) {
      expect(canViewHomePostFull("free", role)).toBe(true);
      expect(homePostIsLocked("free", role)).toBe(false);
    }
  });

  it("members-only posts open for owner and VIP, lock for a plain member", () => {
    expect(canViewHomePostFull("members", "owner")).toBe(true);
    expect(canViewHomePostFull("members", "vip")).toBe(true);
    expect(canViewHomePostFull("members", "members")).toBe(false);
    expect(homePostIsLocked("members", "members")).toBe(true);
  });
});

describe("isPostLockedForViewer", () => {
  const vipPost = { visibility: "members" as const, locked: true };
  const openVipPost = { visibility: "members" as const, locked: false };

  it("a plain member follows the API's answer, whatever the inspector says", () => {
    expect(isPostLockedForViewer(vipPost, false, "auto")).toBe(true);
    expect(isPostLockedForViewer(vipPost, false, "members")).toBe(true);
    expect(isPostLockedForViewer(openVipPost, false, "owner")).toBe(false);
  });

  it("staff in auto follow the API too (always unlocked for them)", () => {
    expect(isPostLockedForViewer(openVipPost, true, "auto")).toBe(false);
  });

  it("staff can inspect as a member without VIP and see the lock", () => {
    expect(isPostLockedForViewer(openVipPost, true, "members")).toBe(true);
    expect(
      isPostLockedForViewer({ visibility: "free", locked: false }, true, "members"),
    ).toBe(false);
  });
});

describe("resolveCommunityHomeViewer", () => {
  it("auto follows membership: owner, then VIP, else member", () => {
    expect(resolveCommunityHomeViewer({ mode: "auto", isOwner: true, isVip: true })).toBe("owner");
    expect(resolveCommunityHomeViewer({ mode: "auto", isOwner: false, isVip: true })).toBe("vip");
    expect(resolveCommunityHomeViewer({ mode: "auto", isOwner: false, isVip: false })).toBe("members");
  });

  it("explicit modes ignore membership", () => {
    expect(resolveCommunityHomeViewer({ mode: "members", isOwner: true, isVip: true })).toBe("members");
    expect(resolveCommunityHomeViewer({ mode: "owner", isOwner: false, isVip: false })).toBe("owner");
  });
});

describe("lockedPostSummary", () => {
  it("prefers the teaser, falls back to the title, never invents a body", () => {
    expect(lockedPostSummary({ title: "Sessão 11", teaser: "só o inner vê" })).toBe("só o inner vê");
    expect(lockedPostSummary({ title: "Sessão 11", teaser: "  " })).toBe("Sessão 11");
    expect(lockedPostSummary({ title: null, teaser: null })).toBeNull();
  });
});

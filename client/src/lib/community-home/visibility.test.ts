import { describe, expect, it } from "vitest";
import {
  canViewHomePostFull,
  homePostIsLocked,
  isPostLockedForViewer,
} from "./visibility";
import {
  loadCommunityHomeViewerMode,
  resolveCommunityHomeViewer,
  saveCommunityHomeViewerMode,
} from "./viewer";

describe("home post lock visibility", () => {
  it("free posts are open to members, vip, and owner", () => {
    for (const viewer of ["members", "vip", "owner"] as const) {
      expect(canViewHomePostFull("free", viewer)).toBe(true);
      expect(homePostIsLocked("free", viewer)).toBe(false);
    }
  });

  it("members-only posts lock for plain members", () => {
    expect(canViewHomePostFull("members", "members")).toBe(false);
    expect(homePostIsLocked("members", "members")).toBe(true);
  });

  it("members-only posts open for VIP and owner", () => {
    expect(canViewHomePostFull("members", "vip")).toBe(true);
    expect(canViewHomePostFull("members", "owner")).toBe(true);
    expect(homePostIsLocked("members", "vip")).toBe(false);
  });

  it("isPostLockedForViewer trusts API locked in auto mode", () => {
    expect(
      isPostLockedForViewer(
        { visibility: "members", locked: true },
        false,
        "auto",
      ),
    ).toBe(true);
    expect(
      isPostLockedForViewer(
        { visibility: "members", locked: false },
        true,
        "auto",
      ),
    ).toBe(false);
  });

  it("staff inspector can simulate the locked teaser", () => {
    expect(
      isPostLockedForViewer(
        { visibility: "members", locked: false },
        true,
        "members",
      ),
    ).toBe(true);
    expect(
      isPostLockedForViewer(
        { visibility: "members", locked: false },
        true,
        "owner",
      ),
    ).toBe(false);
  });
});

describe("resolveCommunityHomeViewer", () => {
  it("auto prefers owner, then vip, else members", () => {
    expect(
      resolveCommunityHomeViewer({
        mode: "auto",
        isOwner: true,
        isVip: true,
      }),
    ).toBe("owner");
    expect(
      resolveCommunityHomeViewer({
        mode: "auto",
        isOwner: false,
        isVip: true,
      }),
    ).toBe("vip");
    expect(
      resolveCommunityHomeViewer({
        mode: "auto",
        isOwner: false,
        isVip: false,
      }),
    ).toBe("members");
  });

  it("explicit mode overrides real membership", () => {
    expect(
      resolveCommunityHomeViewer({
        mode: "members",
        isOwner: true,
        isVip: true,
      }),
    ).toBe("members");
    expect(
      resolveCommunityHomeViewer({
        mode: "owner",
        isOwner: false,
        isVip: false,
      }),
    ).toBe("owner");
  });
});

describe("viewer mode storage", () => {
  it("reads ?homeViewer= and sticky-writes; free remaps to members", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    expect(loadCommunityHomeViewerMode("?homeViewer=free", storage)).toBe(
      "members",
    );
    expect(map.get("pqp:community-home-viewer")).toBe("members");
  });

  it("saveCommunityHomeViewerMode persists", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    saveCommunityHomeViewerMode("members", storage);
    expect(loadCommunityHomeViewerMode("", storage)).toBe("members");
  });
});

import { describe, expect, it } from "vitest";
import {
  canViewHomePostFull,
  homePostIsLocked,
} from "./visibility";
import {
  loadCommunityHomeViewerMode,
  resolveCommunityHomeViewer,
  saveCommunityHomeViewerMode,
} from "./viewer";

describe("home post lock visibility", () => {
  it("free posts are open to free, vip, and owner", () => {
    for (const viewer of ["free", "vip", "owner"] as const) {
      expect(canViewHomePostFull("free", viewer)).toBe(true);
      expect(homePostIsLocked("free", viewer)).toBe(false);
    }
  });

  it("members-only posts lock for free members", () => {
    expect(canViewHomePostFull("members", "free")).toBe(false);
    expect(homePostIsLocked("members", "free")).toBe(true);
  });

  it("members-only posts open for VIP and owner", () => {
    expect(canViewHomePostFull("members", "vip")).toBe(true);
    expect(canViewHomePostFull("members", "owner")).toBe(true);
    expect(homePostIsLocked("members", "vip")).toBe(false);
  });
});

describe("resolveCommunityHomeViewer", () => {
  it("auto prefers owner, then vip, else free", () => {
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
    ).toBe("free");
  });

  it("explicit mode overrides real membership", () => {
    expect(
      resolveCommunityHomeViewer({
        mode: "free",
        isOwner: true,
        isVip: true,
      }),
    ).toBe("free");
    expect(
      resolveCommunityHomeViewer({
        mode: "vip",
        isOwner: false,
        isVip: false,
      }),
    ).toBe("vip");
  });
});

describe("viewer mode storage", () => {
  it("reads ?homeViewer= and sticky-writes", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    expect(loadCommunityHomeViewerMode("?homeViewer=free", storage)).toBe(
      "free",
    );
    expect(map.get("pqp:community-home-viewer")).toBe("free");
  });

  it("saveCommunityHomeViewerMode persists", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    saveCommunityHomeViewerMode("vip", storage);
    expect(loadCommunityHomeViewerMode("", storage)).toBe("vip");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
});

const {
  channelSidebarIconsOnly,
  loadChannelSidebarPreference,
  saveChannelSidebarPreference,
  toggledChannelSidebarPreference,
} = await import("./channel-sidebar-preference");

const COLUMN = { columnLayout: true, watchingAShare: false };

describe("channelSidebarIconsOnly", () => {
  it("follows somebody else's share while nobody has chosen", () => {
    expect(channelSidebarIconsOnly("auto", COLUMN)).toBe(false);
    expect(
      channelSidebarIconsOnly("auto", { ...COLUMN, watchingAShare: true }),
    ).toBe(true);
  });

  it("stops following it the moment somebody chooses", () => {
    expect(
      channelSidebarIconsOnly("open", { ...COLUMN, watchingAShare: true }),
    ).toBe(false);
    expect(channelSidebarIconsOnly("icons", COLUMN)).toBe(true);
  });

  it("never collapses a drawer, whatever is stored", () => {
    for (const preference of ["auto", "open", "icons"] as const) {
      expect(
        channelSidebarIconsOnly(preference, {
          columnLayout: false,
          watchingAShare: true,
        }),
      ).toBe(false);
    }
  });
});

describe("toggledChannelSidebarPreference", () => {
  it("writes an explicit choice in both directions, never back to auto", () => {
    expect(toggledChannelSidebarPreference(false)).toBe("icons");
    expect(toggledChannelSidebarPreference(true)).toBe("open");
  });
});

describe("stored preference", () => {
  afterEach(() => store.clear());

  it("starts unchosen", () => {
    expect(loadChannelSidebarPreference()).toBe("auto");
  });

  it("survives a reload in both directions", () => {
    saveChannelSidebarPreference("icons");
    expect(loadChannelSidebarPreference()).toBe("icons");
    saveChannelSidebarPreference("open");
    expect(loadChannelSidebarPreference()).toBe("open");
  });

  it("treats an unknown stored value as unchosen", () => {
    store.set("pqp:channel-sidebar", "collapsed-ish");
    expect(loadChannelSidebarPreference()).toBe("auto");
  });
});

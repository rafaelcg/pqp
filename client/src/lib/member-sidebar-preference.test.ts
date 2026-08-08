import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMBER_SIDEBAR_MIN_WIDTH,
  loadMemberSidebarPreference,
  memberSidebarVisible,
  saveMemberSidebarPreference,
} from "./member-sidebar-preference";

describe("memberSidebarVisible", () => {
  it("follows the width when nothing has been chosen", () => {
    expect(memberSidebarVisible(null, true)).toBe(true);
    expect(memberSidebarVisible(null, false)).toBe(false);
  });

  it("lets an explicit choice beat the width, in both directions", () => {
    expect(memberSidebarVisible(false, true)).toBe(false);
    expect(memberSidebarVisible(true, false)).toBe(true);
  });

  it("puts the default breakpoint above a laptop's chrome budget", () => {
    expect(MEMBER_SIDEBAR_MIN_WIDTH).toBeGreaterThan(1024);
  });
});

describe("stored preference", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips both answers", () => {
    saveMemberSidebarPreference(false);
    expect(loadMemberSidebarPreference()).toBe(false);
    saveMemberSidebarPreference(true);
    expect(loadMemberSidebarPreference()).toBe(true);
  });

  it("reads an empty store as unchosen rather than as closed", () => {
    expect(loadMemberSidebarPreference()).toBeNull();
  });

  it("reads junk as unchosen", () => {
    store.set("pqp:member-sidebar", "{}");
    expect(loadMemberSidebarPreference()).toBeNull();
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadMemberSidebarPreference()).toBeNull();
    expect(() => saveMemberSidebarPreference(true)).not.toThrow();
  });
});

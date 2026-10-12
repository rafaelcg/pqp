import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  foldSection,
  loadCollapsedCategories,
  sectionCollapseKey,
  toggleCollapsedCategory,
} from "./collapsed-categories";

describe("foldSection", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const none = () => false;

  it("shows every row while open", () => {
    const out = foldSection(rows, {
      collapsed: false,
      selectedChannelId: null,
      activeVoiceChannelId: null,
      isUnread: none,
    });
    expect(out.shown).toEqual(rows);
    expect(out.hasUnread).toBe(false);
  });

  it("keeps only the open channel and the call while folded", () => {
    const out = foldSection(rows, {
      collapsed: true,
      selectedChannelId: "a",
      activeVoiceChannelId: "c",
      isUnread: none,
    });
    expect(out.shown.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("does not count the open channel as unread", () => {
    const only = (id: string) => (c: { id: string }) => c.id === id;
    const base = { collapsed: true, selectedChannelId: "a", activeVoiceChannelId: null };
    expect(foldSection(rows, { ...base, isUnread: only("a") }).hasUnread).toBe(false);
    expect(foldSection(rows, { ...base, isUnread: only("b") }).hasUnread).toBe(true);
  });
});

/**
 * The suite runs under vitest's `node` environment (chosen so the rest of the
 * unit tests do not pay for jsdom), which has no `localStorage` global at
 * all — this stubs in just enough of the real API for the module under test.
 */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    clear: () => store.clear(),
  };
}

describe("collapsed categories", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts empty with nothing stored", () => {
    expect(loadCollapsedCategories()).toEqual(new Set());
  });

  it("toggling an uncollapsed category collapses it, and persists that", () => {
    const result = toggleCollapsedCategory("cat-1");
    expect(result.has("cat-1")).toBe(true);
    expect(loadCollapsedCategories().has("cat-1")).toBe(true);
  });

  it("toggling a collapsed category expands it again", () => {
    toggleCollapsedCategory("cat-1");
    const result = toggleCollapsedCategory("cat-1");
    expect(result.has("cat-1")).toBe(false);
    expect(loadCollapsedCategories().has("cat-1")).toBe(false);
  });

  it("keeps other collapsed categories untouched when toggling one", () => {
    toggleCollapsedCategory("cat-1");
    toggleCollapsedCategory("cat-2");
    const result = toggleCollapsedCategory("cat-1");
    expect(result.has("cat-1")).toBe(false);
    expect(result.has("cat-2")).toBe(true);
  });

  it("treats corrupt storage as nothing collapsed rather than throwing", () => {
    localStorage.setItem("pqp:collapsed-categories", "{not json");
    expect(loadCollapsedCategories()).toEqual(new Set());
  });

  it("namespaces the Texto and Voz section keys per server", () => {
    expect(sectionCollapseKey("s1", "text")).toBe("text:s1");
    expect(sectionCollapseKey("s1", "voice")).toBe("voice:s1");
    toggleCollapsedCategory(sectionCollapseKey("s1", "text"));
    expect(loadCollapsedCategories().has(sectionCollapseKey("s2", "text"))).toBe(false);
  });

  it("ignores a stored value that is not an array of strings", () => {
    localStorage.setItem(
      "pqp:collapsed-categories",
      JSON.stringify({ not: "an array" }),
    );
    expect(loadCollapsedCategories()).toEqual(new Set());
  });
});

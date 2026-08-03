import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadCollapsedCategories,
  toggleCollapsedCategory,
} from "./collapsed-categories";

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

  it("ignores a stored value that is not an array of strings", () => {
    localStorage.setItem(
      "pqp:collapsed-categories",
      JSON.stringify({ not: "an array" }),
    );
    expect(loadCollapsedCategories()).toEqual(new Set());
  });
});

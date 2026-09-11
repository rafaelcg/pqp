import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  readDraft,
  resetComposerDraftsForTests,
  subscribeDrafts,
  writeDraft,
} from "./composer-drafts";

describe("composer drafts", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    resetComposerDraftsForTests();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a draft per channel across a fresh read", () => {
    writeDraft("c1", "half a thought");
    writeDraft("c2", "another");
    resetComposerDraftsForTests();
    expect(readDraft("c1")).toBe("half a thought");
    expect(readDraft("c2")).toBe("another");
    expect(readDraft("c3")).toBe("");
  });

  it("clears on an empty body and drops the key when nothing is left", () => {
    writeDraft("c1", "x");
    writeDraft("c1", "   ");
    expect(readDraft("c1")).toBe("");
    expect(store.size).toBe(0);
    writeDraft("c1", "y");
    clearDraft("c1");
    expect(store.size).toBe(0);
  });

  it("notifies subscribers when the set of channels changes", () => {
    const seen = vi.fn();
    subscribeDrafts(seen);
    writeDraft("c1", "a");
    writeDraft("c1", "a");
    writeDraft("c1", "ab");
    clearDraft("c1");
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("caps the store at 50 newest and forgets drafts older than 30 days", () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 60; i += 1) {
      writeDraft(`c${i}`, `d${i}`, now + i);
    }
    expect(readDraft("c9")).toBe("");
    expect(readDraft("c10")).toBe("d10");
    expect(readDraft("c59")).toBe("d59");

    writeDraft("old", "stale", now - 31 * 24 * 60 * 60 * 1000);
    resetComposerDraftsForTests();
    vi.spyOn(Date, "now").mockReturnValue(now + 100);
    expect(readDraft("old")).toBe("");
    expect(readDraft("c59")).toBe("d59");
    vi.restoreAllMocks();
  });

  it("survives unreadable storage", () => {
    store.set("pqp:composer-drafts", "{nope");
    expect(readDraft("c1")).toBe("");
  });
});

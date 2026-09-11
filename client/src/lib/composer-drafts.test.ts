import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  draftsAreDirty,
  readDraft,
  resetComposerDraftsForTests,
  setDraftsAccount,
  subscribeDrafts,
  writeDraft,
} from "./composer-drafts";

const KEY = "pqp:composer-drafts:u1";

describe("composer drafts", () => {
  const store = new Map<string, string>();
  let failWrites = false;
  let failReads = false;

  beforeEach(() => {
    store.clear();
    failWrites = false;
    failReads = false;
    resetComposerDraftsForTests();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (failReads) {
          throw new Error("blocked");
        }
        return store.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (failWrites) {
          throw new Error("full");
        }
        store.set(key, value);
      },
      removeItem: (key: string) => void store.delete(key),
    });
    setDraftsAccount("u1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a draft per channel across a fresh read", () => {
    writeDraft("c1", "half a thought");
    writeDraft("c2", "another");
    resetComposerDraftsForTests();
    setDraftsAccount("u1");
    expect(readDraft("c1")).toBe("half a thought");
    expect(readDraft("c2")).toBe("another");
    expect(readDraft("c3")).toBe("");
  });

  it("is scoped to the account: signed out reads empty, another account sees nothing", () => {
    writeDraft("c1", "mine");
    setDraftsAccount(null);
    expect(readDraft("c1")).toBe("");
    writeDraft("c1", "ignored");
    setDraftsAccount("u2");
    expect(readDraft("c1")).toBe("");
    setDraftsAccount("u1");
    expect(readDraft("c1")).toBe("mine");
    expect(store.has(KEY)).toBe(true);
    expect(store.size).toBe(1);
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

  it("notifies subscribers only when the set of channels changes", () => {
    const seen = vi.fn();
    subscribeDrafts(seen);
    writeDraft("c1", "a");
    writeDraft("c1", "a");
    writeDraft("c1", "ab");
    clearDraft("c1");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("merges around what another tab wrote since the last read", () => {
    writeDraft("c1", "tab A");
    // Tab B wrote c2 straight into storage without this tab seeing it.
    const other = JSON.parse(store.get(KEY)!) as Record<string, unknown>;
    other.c2 = { body: "tab B", updatedAt: Date.now() };
    store.set(KEY, JSON.stringify(other));

    writeDraft("c1", "tab A, more");
    const saved = JSON.parse(store.get(KEY)!) as Record<string, { body: string }>;
    expect(saved.c1!.body).toBe("tab A, more");
    expect(saved.c2!.body).toBe("tab B");
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
    setDraftsAccount("u1");
    expect(readDraft("old")).toBe("");
    expect(readDraft("c59")).toBe("d59");
    vi.restoreAllMocks();
  });

  it("does not remember an unreadable storage as empty", () => {
    writeDraft("c1", "kept");
    resetComposerDraftsForTests();
    failReads = true;
    setDraftsAccount("u1");
    expect(readDraft("c1")).toBe("");
    failReads = false;
    expect(readDraft("c1")).toBe("kept");
  });

  it("stays dirty after a failed write and retries on the next one", () => {
    failWrites = true;
    writeDraft("c1", "unsaved");
    expect(draftsAreDirty()).toBe(true);
    expect(readDraft("c1")).toBe("unsaved");
    expect(store.size).toBe(0);
    failWrites = false;
    writeDraft("c1", "unsaved");
    expect(draftsAreDirty()).toBe(false);
    expect(JSON.parse(store.get(KEY)!).c1.body).toBe("unsaved");
  });

  it("survives unreadable content", () => {
    store.set(KEY, "{nope");
    expect(readDraft("c1")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  WHATS_NEW_FEED_STORAGE_KEY,
  hasUnseenWhatsNew,
  newestPostSlug,
  rememberWhatsNewFeed,
} from "./whats-new-feed";
import { POSTS } from "./blog/posts";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function hostileStorage() {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
}

describe("newestPostSlug", () => {
  it("is the first entry in POSTS", () => {
    expect(newestPostSlug()).toBe(POSTS[0]!.slug);
  });
});

describe("hasUnseenWhatsNew", () => {
  it("is true when this browser has never opened the feed", () => {
    expect(hasUnseenWhatsNew(fakeStorage())).toBe(true);
  });

  it("is false once the newest slug is recorded", () => {
    expect(
      hasUnseenWhatsNew(
        fakeStorage({ [WHATS_NEW_FEED_STORAGE_KEY]: newestPostSlug() }),
      ),
    ).toBe(false);
  });

  it("is true when a previous slug is what was recorded", () => {
    expect(
      hasUnseenWhatsNew(
        fakeStorage({ [WHATS_NEW_FEED_STORAGE_KEY]: "older-than-now" }),
      ),
    ).toBe(true);
  });

  it("fails toward silence when there is no store", () => {
    expect(hasUnseenWhatsNew(null)).toBe(false);
  });

  it("fails toward silence when the store refuses the read", () => {
    expect(hasUnseenWhatsNew(hostileStorage())).toBe(false);
  });
});

describe("rememberWhatsNewFeed", () => {
  it("records the newest slug so the next read hides the pip", () => {
    const storage = fakeStorage();
    rememberWhatsNewFeed(storage);
    expect(hasUnseenWhatsNew(storage)).toBe(false);
    expect(storage.getItem(WHATS_NEW_FEED_STORAGE_KEY)).toBe(newestPostSlug());
  });

  it("does not throw when the store refuses the write", () => {
    expect(() => rememberWhatsNewFeed(hostileStorage())).not.toThrow();
    expect(() => rememberWhatsNewFeed(null)).not.toThrow();
  });
});

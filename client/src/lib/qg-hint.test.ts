import { describe, expect, it } from "vitest";
import {
  QG_HINT_SLUG,
  QG_HINT_STORAGE_KEY,
  isQgHintSeen,
  rememberQgHint,
  shouldPersistQgHint,
  shouldShowQgHint,
} from "./qg-hint";

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

describe("shouldPersistQgHint", () => {
  it("stays off on localhost so a preview reloads the card", () => {
    expect(shouldPersistQgHint("localhost")).toBe(false);
    expect(shouldPersistQgHint("127.0.0.1")).toBe(false);
  });

  it("persists on a real host", () => {
    expect(shouldPersistQgHint("pqp.gg")).toBe(true);
    expect(shouldPersistQgHint("pqp-3yr.pages.dev")).toBe(true);
  });
});

describe("isQgHintSeen", () => {
  it("is always unseen when persist is off", () => {
    expect(
      isQgHintSeen(fakeStorage({ [QG_HINT_STORAGE_KEY]: "1" }), false),
    ).toBe(false);
  });

  it("is unseen with nothing stored", () => {
    expect(isQgHintSeen(fakeStorage(), true)).toBe(false);
  });

  it("is seen once the impression is recorded", () => {
    expect(
      isQgHintSeen(fakeStorage({ [QG_HINT_STORAGE_KEY]: "1" }), true),
    ).toBe(true);
  });

  it("treats a missing store as already seen", () => {
    expect(isQgHintSeen(null, true)).toBe(true);
  });

  it("does not throw when the store refuses the read", () => {
    expect(isQgHintSeen(hostileStorage(), true)).toBe(true);
  });
});

describe("rememberQgHint", () => {
  it("writes nothing when persist is off", () => {
    const storage = fakeStorage();
    rememberQgHint(storage, false);
    expect(storage.getItem(QG_HINT_STORAGE_KEY)).toBeNull();
  });

  it("records the impression so the next read hides the card", () => {
    const storage = fakeStorage();
    rememberQgHint(storage, true);
    expect(isQgHintSeen(storage, true)).toBe(true);
  });

  it("does not throw when the store refuses the write", () => {
    expect(() => rememberQgHint(hostileStorage(), true)).not.toThrow();
    expect(() => rememberQgHint(null, true)).not.toThrow();
  });
});

describe("shouldShowQgHint", () => {
  const base = {
    automated: false,
    seen: false,
    listed: true,
    joined: false,
    preview: false,
  };

  it("hides for Playwright so e2e does not click through it", () => {
    expect(shouldShowQgHint({ ...base, automated: true })).toBe(false);
  });

  it("hides once this device has been shown it", () => {
    expect(shouldShowQgHint({ ...base, seen: true })).toBe(false);
  });

  it("hides when the account is already in the QG", () => {
    expect(shouldShowQgHint({ ...base, joined: true })).toBe(false);
  });

  it("shows when the QG is listed and they are not in it", () => {
    expect(shouldShowQgHint(base)).toBe(true);
  });

  it("hides on a self-host that does not list the QG", () => {
    expect(shouldShowQgHint({ ...base, listed: false })).toBe(false);
  });

  it("still shows on localhost when the community is missing, for preview", () => {
    expect(
      shouldShowQgHint({
        ...base,
        listed: false,
        preview: true,
      }),
    ).toBe(true);
  });

  it("keeps the hosted slug pointing at the HQ", () => {
    expect(QG_HINT_SLUG).toBe("qg-do-pqp");
  });
});

import { describe, expect, it } from "vitest";
import {
  MOBILE_BETA_HINT_STORAGE_KEY,
  isMobileBetaHintSeen,
  rememberMobileBetaHint,
  shouldPersistMobileBetaHint,
  shouldShowMobileBetaHint,
} from "./mobile-beta-hint";

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

const phone = {
  automated: false,
  desktopApp: false,
  android: true,
  ios: false,
  seen: false,
} as const;

describe("shouldPersistMobileBetaHint", () => {
  it("never persists on localhost", () => {
    expect(shouldPersistMobileBetaHint("localhost")).toBe(false);
    expect(shouldPersistMobileBetaHint("127.0.0.1")).toBe(false);
  });

  it("persists on a real host", () => {
    expect(shouldPersistMobileBetaHint("pqp.gg")).toBe(true);
    expect(shouldPersistMobileBetaHint("pqp-3yr.pages.dev")).toBe(true);
  });
});

describe("isMobileBetaHintSeen", () => {
  it("is false on localhost even with a stored flag", () => {
    expect(
      isMobileBetaHintSeen(
        fakeStorage({ [MOBILE_BETA_HINT_STORAGE_KEY]: "1" }),
        false,
      ),
    ).toBe(false);
  });

  it("is false with nothing stored", () => {
    expect(isMobileBetaHintSeen(fakeStorage(), true)).toBe(false);
  });

  it("is true once the impression is recorded", () => {
    expect(
      isMobileBetaHintSeen(
        fakeStorage({ [MOBILE_BETA_HINT_STORAGE_KEY]: "1" }),
        true,
      ),
    ).toBe(true);
  });

  it("treats missing storage as already seen", () => {
    expect(isMobileBetaHintSeen(null, true)).toBe(true);
  });

  it("does not throw when the store refuses the read", () => {
    expect(isMobileBetaHintSeen(hostileStorage(), true)).toBe(true);
  });
});

describe("rememberMobileBetaHint", () => {
  it("is a no-op when persistence is off", () => {
    const storage = fakeStorage();
    rememberMobileBetaHint(storage, false);
    expect(isMobileBetaHintSeen(storage, true)).toBe(false);
  });

  it("records the impression so the next read hides the card", () => {
    const storage = fakeStorage();
    rememberMobileBetaHint(storage, true);
    expect(isMobileBetaHintSeen(storage, true)).toBe(true);
  });

  it("does not throw when the store refuses the write", () => {
    expect(() => rememberMobileBetaHint(hostileStorage(), true)).not.toThrow();
    expect(() => rememberMobileBetaHint(null, true)).not.toThrow();
  });
});

describe("shouldShowMobileBetaHint", () => {
  it("shows on an Android phone that has not seen it", () => {
    expect(shouldShowMobileBetaHint(phone)).toBe(true);
  });

  it("shows on an iPhone that has not seen it", () => {
    expect(
      shouldShowMobileBetaHint({ ...phone, android: false, ios: true }),
    ).toBe(true);
  });

  it("hides in Playwright", () => {
    expect(shouldShowMobileBetaHint({ ...phone, automated: true })).toBe(false);
  });

  it("hides in the desktop shell", () => {
    expect(shouldShowMobileBetaHint({ ...phone, desktopApp: true })).toBe(
      false,
    );
  });

  it("hides on a laptop browser", () => {
    expect(
      shouldShowMobileBetaHint({ ...phone, android: false, ios: false }),
    ).toBe(false);
  });

  it("hides once seen", () => {
    expect(shouldShowMobileBetaHint({ ...phone, seen: true })).toBe(false);
  });
});

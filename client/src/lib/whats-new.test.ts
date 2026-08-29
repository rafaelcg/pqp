import { describe, expect, it } from "vitest";
import {
  WHATS_NEW_PACK_ID,
  WHATS_NEW_STORAGE_KEY,
  isWhatsNewSeen,
  rememberWhatsNew,
} from "./whats-new";

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

describe("isWhatsNewSeen", () => {
  it("is false when this pack has not been recorded", () => {
    expect(isWhatsNewSeen(WHATS_NEW_PACK_ID, fakeStorage())).toBe(false);
  });

  it("is true once this pack is recorded", () => {
    expect(
      isWhatsNewSeen(
        WHATS_NEW_PACK_ID,
        fakeStorage({ [WHATS_NEW_STORAGE_KEY]: WHATS_NEW_PACK_ID }),
      ),
    ).toBe(true);
  });

  it("is false when a previous pack is what was recorded", () => {
    expect(
      isWhatsNewSeen(
        WHATS_NEW_PACK_ID,
        fakeStorage({ [WHATS_NEW_STORAGE_KEY]: "roles" }),
      ),
    ).toBe(false);
  });

  it("fails toward silence when there is no store", () => {
    expect(isWhatsNewSeen(WHATS_NEW_PACK_ID, null)).toBe(true);
  });

  it("fails toward silence when the store refuses the read", () => {
    expect(isWhatsNewSeen(WHATS_NEW_PACK_ID, hostileStorage())).toBe(true);
  });
});

describe("rememberWhatsNew", () => {
  it("records the pack so the next read hides the card", () => {
    const storage = fakeStorage();
    rememberWhatsNew(WHATS_NEW_PACK_ID, storage);
    expect(isWhatsNewSeen(WHATS_NEW_PACK_ID, storage)).toBe(true);
  });

  it("does not throw when the store refuses the write", () => {
    expect(() => rememberWhatsNew(WHATS_NEW_PACK_ID, hostileStorage())).not.toThrow();
    expect(() => rememberWhatsNew(WHATS_NEW_PACK_ID, null)).not.toThrow();
  });
});

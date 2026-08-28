import { describe, expect, it } from "vitest";
import {
  CARGOS_HINT_STORAGE_KEY,
  isCargosHintSeen,
  rememberCargosHint,
  shouldPersistCargosHint,
} from "./cargos-hint";

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

describe("shouldPersistCargosHint", () => {
  it("stays off on localhost so a preview reloads the card", () => {
    expect(shouldPersistCargosHint("localhost")).toBe(false);
    expect(shouldPersistCargosHint("127.0.0.1")).toBe(false);
  });

  it("persists on a real host", () => {
    expect(shouldPersistCargosHint("pqp.gg")).toBe(true);
    expect(shouldPersistCargosHint("pqp-3yr.pages.dev")).toBe(true);
  });
});

describe("isCargosHintSeen", () => {
  it("is always unseen when persist is off", () => {
    expect(
      isCargosHintSeen(
        fakeStorage({ [CARGOS_HINT_STORAGE_KEY]: "1" }),
        false,
      ),
    ).toBe(false);
  });

  it("is unseen with nothing stored", () => {
    expect(isCargosHintSeen(fakeStorage(), true)).toBe(false);
  });

  it("is seen once the impression is recorded", () => {
    expect(
      isCargosHintSeen(
        fakeStorage({ [CARGOS_HINT_STORAGE_KEY]: "1" }),
        true,
      ),
    ).toBe(true);
  });

  it("treats a missing store as already seen", () => {
    expect(isCargosHintSeen(null, true)).toBe(true);
  });

  it("does not throw when the store refuses the read", () => {
    expect(isCargosHintSeen(hostileStorage(), true)).toBe(true);
  });
});

describe("rememberCargosHint", () => {
  it("writes nothing when persist is off", () => {
    const storage = fakeStorage();
    rememberCargosHint(storage, false);
    expect(storage.getItem(CARGOS_HINT_STORAGE_KEY)).toBeNull();
  });

  it("records the impression so the next read hides the card", () => {
    const storage = fakeStorage();
    rememberCargosHint(storage, true);
    expect(isCargosHintSeen(storage, true)).toBe(true);
  });

  it("does not throw when the store refuses the write", () => {
    expect(() => rememberCargosHint(hostileStorage(), true)).not.toThrow();
    expect(() => rememberCargosHint(null, true)).not.toThrow();
  });
});

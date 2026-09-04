import { describe, expect, it } from "vitest";
import { isCommunityHomeEnabled, setCommunityHomeEnabled } from "./flag";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe("isCommunityHomeEnabled", () => {
  it("fails closed with no config", () => {
    expect(
      isCommunityHomeEnabled({
        config: null,
        allowLocalOverride: false,
        search: "",
        storage: memoryStorage(),
      }),
    ).toBe(false);
  });

  it("follows the server config", () => {
    const storage = memoryStorage();
    expect(
      isCommunityHomeEnabled({
        config: { enabled: true },
        allowLocalOverride: false,
        search: "",
        storage,
      }),
    ).toBe(true);
    expect(
      isCommunityHomeEnabled({
        config: { enabled: false },
        allowLocalOverride: false,
        search: "",
        storage,
      }),
    ).toBe(false);
  });

  it("ignores the query and the latch outside the dev bypass", () => {
    const storage = memoryStorage({ "pqp:community-home": "1" });
    expect(
      isCommunityHomeEnabled({
        config: { enabled: false },
        allowLocalOverride: false,
        search: "?communityHome=1",
        storage,
      }),
    ).toBe(false);
    // Nothing was written either.
    expect(storage.dump()).toEqual({ "pqp:community-home": "1" });
  });

  it("with the bypass, the query wins and latches", () => {
    const storage = memoryStorage();
    expect(
      isCommunityHomeEnabled({
        config: { enabled: false },
        allowLocalOverride: true,
        search: "?communityHome=1",
        storage,
      }),
    ).toBe(true);
    expect(storage.dump()).toEqual({ "pqp:community-home": "1" });
    // Next navigation without the query: the latch holds.
    expect(
      isCommunityHomeEnabled({
        config: { enabled: false },
        allowLocalOverride: true,
        search: "",
        storage,
      }),
    ).toBe(true);
  });

  it("with the bypass, ?communityHome=0 forces off even when the API says on", () => {
    const storage = memoryStorage();
    expect(
      isCommunityHomeEnabled({
        config: { enabled: true },
        allowLocalOverride: true,
        search: "?communityHome=0",
        storage,
      }),
    ).toBe(false);
    expect(storage.dump()).toEqual({ "pqp:community-home": "0" });
  });

  it("with the bypass and no latch, the server config still decides", () => {
    expect(
      isCommunityHomeEnabled({
        config: { enabled: true },
        allowLocalOverride: true,
        search: "",
        storage: memoryStorage(),
      }),
    ).toBe(true);
  });

  it("setCommunityHomeEnabled(null) clears the latch", () => {
    const storage = memoryStorage({ "pqp:community-home": "1" });
    setCommunityHomeEnabled(null, storage);
    expect(storage.dump()).toEqual({});
  });
});

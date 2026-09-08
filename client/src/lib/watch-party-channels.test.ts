import { describe, expect, it } from "vitest";
import {
  resolveWatchPartyChannelsFlag,
  setWatchPartyChannelsEnabled,
} from "./watch-party-channels";

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

describe("resolveWatchPartyChannelsFlag", () => {
  it("fails closed with no env", () => {
    expect(
      resolveWatchPartyChannelsFlag({
        env: undefined,
        allowLocalOverride: false,
        search: "",
        storage: memoryStorage(),
      }),
    ).toBe(false);
  });

  it("follows the build env, and only the literal true", () => {
    const storage = memoryStorage();
    expect(
      resolveWatchPartyChannelsFlag({
        env: "true",
        allowLocalOverride: false,
        search: "",
        storage,
      }),
    ).toBe(true);
    for (const off of ["false", "", "1", "yes"]) {
      expect(
        resolveWatchPartyChannelsFlag({
          env: off,
          allowLocalOverride: false,
          search: "",
          storage,
        }),
      ).toBe(false);
    }
  });

  it("ignores the query and the latch outside the dev bypass", () => {
    const storage = memoryStorage({ "pqp:watch-party-channels": "1" });
    expect(
      resolveWatchPartyChannelsFlag({
        env: undefined,
        allowLocalOverride: false,
        search: "?watchParty=1",
        storage,
      }),
    ).toBe(false);
    // Nothing was written either.
    expect(storage.dump()).toEqual({ "pqp:watch-party-channels": "1" });
  });

  it("with the bypass, the query wins and latches", () => {
    const storage = memoryStorage();
    expect(
      resolveWatchPartyChannelsFlag({
        env: undefined,
        allowLocalOverride: true,
        search: "?watchParty=1",
        storage,
      }),
    ).toBe(true);
    expect(storage.dump()).toEqual({ "pqp:watch-party-channels": "1" });
    // Next navigation without the query: the latch holds.
    expect(
      resolveWatchPartyChannelsFlag({
        env: undefined,
        allowLocalOverride: true,
        search: "",
        storage,
      }),
    ).toBe(true);
  });

  it("with the bypass, ?watchParty=0 forces off even when the build says on", () => {
    const storage = memoryStorage();
    expect(
      resolveWatchPartyChannelsFlag({
        env: "true",
        allowLocalOverride: true,
        search: "?watchParty=0",
        storage,
      }),
    ).toBe(false);
    expect(storage.dump()).toEqual({ "pqp:watch-party-channels": "0" });
  });

  it("with the bypass and no latch, the build env still decides", () => {
    expect(
      resolveWatchPartyChannelsFlag({
        env: "true",
        allowLocalOverride: true,
        search: "",
        storage: memoryStorage(),
      }),
    ).toBe(true);
  });

  it("survives a storage that throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(
      resolveWatchPartyChannelsFlag({
        env: undefined,
        allowLocalOverride: true,
        search: "?watchParty=1",
        storage,
      }),
    ).toBe(true);
    expect(
      resolveWatchPartyChannelsFlag({
        env: undefined,
        allowLocalOverride: true,
        search: "",
        storage,
      }),
    ).toBe(false);
  });

  it("setWatchPartyChannelsEnabled(null) clears the latch", () => {
    const storage = memoryStorage({ "pqp:watch-party-channels": "1" });
    setWatchPartyChannelsEnabled(null, storage);
    expect(storage.dump()).toEqual({});
  });
});

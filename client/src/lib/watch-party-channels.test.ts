import { describe, expect, it } from "vitest";
import {
  resolveWatchPartyChannelsFlag,
  setWatchPartyChannelsEnabled,
  canOfferWatchPartyCreate,
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

/**
 * THE QUIET LAUNCH. `START_WATCH_PARTY` was backfilled onto 2753 roles across
 * 908 servers, so the permission bit alone is not a rollout: with the build
 * flag on it would put a create button in front of every one of those
 * moderators, on servers where the feature cannot run. The control therefore
 * also asks the server, and the server's answer is the operator's allowlist.
 */
describe("canOfferWatchPartyCreate", () => {
  it("offers it only where the server says live HLS is on", () => {
    expect(
      canOfferWatchPartyCreate({ hlsEnabled: true, hasPermission: true }),
    ).toBe(true);
    // The 908-server case: the bit is held, the server is not allowlisted.
    expect(
      canOfferWatchPartyCreate({ hlsEnabled: false, hasPermission: true }),
    ).toBe(false);
  });

  it("still needs the permission on an allowlisted server", () => {
    expect(
      canOfferWatchPartyCreate({ hlsEnabled: true, hasPermission: false }),
    ).toBe(false);
  });

  it("treats an unanswered config as no", () => {
    // Opposite of `gateScreenShareStart`, on purpose: a create button that
    // appears a beat late costs nothing, a missed disclosure costs a lot.
    expect(
      canOfferWatchPartyCreate({ hlsEnabled: null, hasPermission: true }),
    ).toBe(false);
  });
});

/**
 * The wiring, scanned rather than rendered, the way
 * `screen-share-gate.test.ts` scans the same file: there is no harness that
 * mounts `App.tsx`, and the regression to catch is somebody passing the raw
 * permission bit to `canStartWatchParty` again, which is exactly what the
 * quiet launch cannot have.
 */
describe("App.tsx gates the create control on the server's answer", () => {
  it("passes canOfferWatchPartyCreate, never the bare permission bit", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../App.tsx", import.meta.url),
      "utf8",
    );
    const prop = source.match(/canStartWatchParty=\{([\s\S]*?)\n\s*onCreateWatchParty/);
    expect(prop).not.toBeNull();
    const value = prop![1];
    expect(value).toContain("canOfferWatchPartyCreate");
    expect(value).toContain("hlsEnabled");
    expect(value).toContain("liveHlsConfig");
  });
});

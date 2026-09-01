import { describe, expect, it } from "vitest";
import {
  COMMUNITY_HOME_STORAGE_KEY,
  isCommunityHomeEnabled,
  setCommunityHomeEnabled,
} from "./flag";
import { pickServerLandingTarget } from "./landing";
import { COMMUNITY_HOME_CHANNEL_ID } from "./id";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("isCommunityHomeEnabled", () => {
  it("is off by default (flag-off path)", () => {
    expect(isCommunityHomeEnabled(undefined, "", memoryStorage())).toBe(false);
  });

  it("turns on from VITE env", () => {
    expect(isCommunityHomeEnabled("true", "", memoryStorage())).toBe(true);
    expect(isCommunityHomeEnabled("false", "", memoryStorage())).toBe(false);
  });

  it("turns on from localStorage latch", () => {
    const storage = memoryStorage({ [COMMUNITY_HOME_STORAGE_KEY]: "1" });
    expect(isCommunityHomeEnabled(undefined, "", storage)).toBe(true);
  });

  it("turns on from ?communityHome=1 and sticky-writes storage", () => {
    const storage = memoryStorage();
    expect(isCommunityHomeEnabled(undefined, "?communityHome=1", storage)).toBe(
      true,
    );
    expect(storage.getItem(COMMUNITY_HOME_STORAGE_KEY)).toBe("1");
  });

  it("turns off from ?communityHome=0", () => {
    const storage = memoryStorage({ [COMMUNITY_HOME_STORAGE_KEY]: "1" });
    expect(isCommunityHomeEnabled("true", "?communityHome=0", storage)).toBe(
      false,
    );
    expect(storage.getItem(COMMUNITY_HOME_STORAGE_KEY)).toBeNull();
  });

  it("setCommunityHomeEnabled writes the latch", () => {
    const storage = memoryStorage();
    setCommunityHomeEnabled(true, storage);
    expect(storage.getItem(COMMUNITY_HOME_STORAGE_KEY)).toBe("1");
    setCommunityHomeEnabled(false, storage);
    expect(storage.getItem(COMMUNITY_HOME_STORAGE_KEY)).toBeNull();
  });
});

describe("pickServerLandingTarget", () => {
  const channels = [
    { id: "v1", type: "voice" as const },
    { id: "t1", type: "text" as const },
    { id: "c1", type: "category" as const },
  ];

  it("flag off lands on the first text channel (today)", () => {
    expect(pickServerLandingTarget(channels, false)).toEqual({
      kind: "channel",
      id: "t1",
    });
  });

  it("flag on lands on Community Home", () => {
    expect(pickServerLandingTarget(channels, true)).toEqual({
      kind: "home",
      id: COMMUNITY_HOME_CHANNEL_ID,
    });
  });

  it("flag off with no text falls back to first non-category", () => {
    expect(
      pickServerLandingTarget(
        [
          { id: "c1", type: "category" },
          { id: "v1", type: "voice" },
        ],
        false,
      ),
    ).toEqual({ kind: "channel", id: "v1" });
  });
});

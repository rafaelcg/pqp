import { describe, expect, it } from "vitest";
import {
  COMMUNITY_HOME_SETTINGS_SEEN_KEY,
  communityHomeRowSeenKey,
  isCommunityHomeRowNew,
  isCommunityHomeSettingsNew,
  markCommunityHomeRowNew,
  markCommunityHomeRowSeen,
  markCommunityHomeSettingsSeen,
} from "./new-badges";

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

describe("Community Home discovery badges", () => {
  it("marks the settings discovery globally", () => {
    const storage = memoryStorage();
    expect(isCommunityHomeSettingsNew(storage)).toBe(true);
    markCommunityHomeSettingsSeen(storage);
    expect(storage.getItem(COMMUNITY_HOME_SETTINGS_SEEN_KEY)).toBe("1");
    expect(isCommunityHomeSettingsNew(storage)).toBe(false);
  });

  it("tracks each server row independently", () => {
    const storage = memoryStorage();
    markCommunityHomeRowSeen("server-a", storage);
    expect(storage.getItem(communityHomeRowSeenKey("server-a"))).toBe("1");
    expect(isCommunityHomeRowNew("server-a", storage)).toBe(false);
    expect(isCommunityHomeRowNew("server-b", storage)).toBe(true);
  });

  it("makes a newly enabled row discoverable again", () => {
    const storage = memoryStorage({
      [communityHomeRowSeenKey("server-a")]: "1",
    });
    markCommunityHomeRowNew("server-a", storage);
    expect(isCommunityHomeRowNew("server-a", storage)).toBe(true);
  });
});

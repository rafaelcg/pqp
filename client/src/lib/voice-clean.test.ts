import { describe, expect, it } from "vitest";
import {
  VOICE_CLEAN_SETTINGS_SEEN_KEY,
  isVoiceCleanSettingsSeen,
  markVoiceCleanSettingsSeen,
  shouldShowVoiceCleanSettingsBadge,
} from "./voice-clean";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("voice clean settings NOVO dot", () => {
  it("is unseen the first time, and remembers once marked", () => {
    const storage = memoryStorage();
    expect(isVoiceCleanSettingsSeen(storage, true)).toBe(false);
    markVoiceCleanSettingsSeen(storage, true);
    expect(storage.getItem(VOICE_CLEAN_SETTINGS_SEEN_KEY)).toBe("1");
    expect(isVoiceCleanSettingsSeen(storage, true)).toBe(true);
  });

  it("clears the badge once the section has been seen", () => {
    expect(
      shouldShowVoiceCleanSettingsBadge({
        settingsSeen: true,
        nudgeDismissed: false,
      }),
    ).toBe(false);
  });

  it("clears the badge for an account that answered the old nudge", () => {
    expect(
      shouldShowVoiceCleanSettingsBadge({
        settingsSeen: false,
        nudgeDismissed: true,
      }),
    ).toBe(false);
  });

  it("shows the badge until either happens", () => {
    expect(
      shouldShowVoiceCleanSettingsBadge({
        settingsSeen: false,
        nudgeDismissed: false,
      }),
    ).toBe(true);
  });
});

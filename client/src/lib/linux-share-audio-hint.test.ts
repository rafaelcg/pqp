import { describe, expect, it } from "vitest";
import {
  HINTS_PERSIST_OVERRIDE_KEY,
  LINUX_SHARE_AUDIO_HINT_STORAGE_KEY,
  isLinuxPlatform,
  isLinuxShareAudioHintSeen,
  linuxShareAudioHintPersists,
  rememberLinuxShareAudioHint,
  shouldShowLinuxShareAudioHint,
  shouldShowLinuxShareAudioNoticeForStartedShare,
} from "./linux-share-audio-hint";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

describe("isLinuxPlatform", () => {
  it("Linux via userAgentData", () => {
    expect(
      isLinuxPlatform({ userAgentData: { platform: "Linux" } }),
    ).toBe(true);
  });

  it("Linux via UA fallback (no userAgentData)", () => {
    expect(
      isLinuxPlatform({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      }),
    ).toBe(true);
  });

  it("Android says Linux in its UA and must not count as Linux", () => {
    expect(
      isLinuxPlatform({ userAgentData: { platform: "Android", mobile: true } }),
    ).toBe(false);
    expect(
      isLinuxPlatform({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36",
      }),
    ).toBe(false);
  });

  it("Windows and macOS are not Linux", () => {
    expect(isLinuxPlatform({ userAgentData: { platform: "Windows" } })).toBe(
      false,
    );
    expect(isLinuxPlatform({ userAgentData: { platform: "macOS" } })).toBe(
      false,
    );
  });
});

describe("shouldShowLinuxShareAudioHint", () => {
  it("Linux, not yet dismissed", () => {
    expect(
      shouldShowLinuxShareAudioHint({ linux: true, seen: false }),
    ).toBe(true);
  });

  it("not on another platform, not once dismissed", () => {
    expect(shouldShowLinuxShareAudioHint({ linux: false, seen: false })).toBe(
      false,
    );
    expect(shouldShowLinuxShareAudioHint({ linux: true, seen: true })).toBe(
      false,
    );
  });
});

describe("shouldShowLinuxShareAudioNoticeForStartedShare", () => {
  it("a Linux share with no audio track, not yet dismissed", () => {
    expect(
      shouldShowLinuxShareAudioNoticeForStartedShare({
        linux: true,
        seen: false,
        hasAudio: false,
      }),
    ).toBe(true);
  });

  it("stays quiet once the share has audio, off Linux, or once dismissed", () => {
    expect(
      shouldShowLinuxShareAudioNoticeForStartedShare({
        linux: true,
        seen: false,
        hasAudio: true,
      }),
    ).toBe(false);
    expect(
      shouldShowLinuxShareAudioNoticeForStartedShare({
        linux: false,
        seen: false,
        hasAudio: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLinuxShareAudioNoticeForStartedShare({
        linux: true,
        seen: true,
        hasAudio: false,
      }),
    ).toBe(false);
  });
});

describe("persistence", () => {
  it("follows the shared store: a real host persists, localhost does not", () => {
    expect(linuxShareAudioHintPersists(memoryStorage(), "pqp.gg")).toBe(true);
    expect(linuxShareAudioHintPersists(memoryStorage(), "localhost")).toBe(
      false,
    );
  });

  it("the override key makes localhost persist too", () => {
    const storage = memoryStorage({ [HINTS_PERSIST_OVERRIDE_KEY]: "1" });
    expect(linuxShareAudioHintPersists(storage, "localhost")).toBe(true);
  });

  it("remember then seen, under the shared key", () => {
    const storage = memoryStorage();
    expect(isLinuxShareAudioHintSeen(storage, true)).toBe(false);
    rememberLinuxShareAudioHint(storage, true);
    expect(storage.map.get(LINUX_SHARE_AUDIO_HINT_STORAGE_KEY)).toBe("1");
    expect(isLinuxShareAudioHintSeen(storage, true)).toBe(true);
  });

  it("without persistence nothing is written and nothing is seen", () => {
    const storage = memoryStorage();
    rememberLinuxShareAudioHint(storage, false);
    expect(storage.map.size).toBe(0);
    expect(isLinuxShareAudioHintSeen(storage, false)).toBe(false);
  });

  it("a throwing storage is not fatal on read or write", () => {
    const hostile: Pick<Storage, "getItem" | "setItem"> = {
      getItem() {
        throw new Error("nope");
      },
      setItem() {
        throw new Error("nope");
      },
    };
    expect(isLinuxShareAudioHintSeen(hostile, true)).toBe(true);
    expect(() => rememberLinuxShareAudioHint(hostile, true)).not.toThrow();
  });
});

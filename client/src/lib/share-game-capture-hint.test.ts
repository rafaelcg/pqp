import { describe, expect, it } from "vitest";
import {
  confirmExclusiveFullscreen,
  earlyEndIsHint,
  isShareGameCaptureHintSilenced,
  SHARE_GAME_CAPTURE_HINT_KEY,
  shouldShowShareCaptureNotice,
  shouldWatchSharePicture,
  silenceShareGameCaptureHint,
} from "./share-game-capture-hint";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("shouldWatchSharePicture", () => {
  it("runs only in the Windows desktop app", () => {
    expect(shouldWatchSharePicture({ desktopPlatform: "win32", silenced: false, automated: false })).toBe(true);
    expect(shouldWatchSharePicture({ desktopPlatform: undefined, silenced: false, automated: false })).toBe(false);
    expect(shouldWatchSharePicture({ desktopPlatform: "darwin", silenced: false, automated: false })).toBe(false);
    expect(shouldWatchSharePicture({ desktopPlatform: "linux", silenced: false, automated: false })).toBe(false);
  });

  it("does not run once silenced, or under automation", () => {
    expect(shouldWatchSharePicture({ desktopPlatform: "win32", silenced: true, automated: false })).toBe(false);
    expect(shouldWatchSharePicture({ desktopPlatform: "win32", silenced: false, automated: true })).toBe(false);
  });
});

describe("don't show again", () => {
  it("persists through the hint store", () => {
    const storage = memoryStorage();
    expect(isShareGameCaptureHintSilenced(storage, true)).toBe(false);
    silenceShareGameCaptureHint(storage, true);
    expect(storage.data.get(SHARE_GAME_CAPTURE_HINT_KEY)).toBe("1");
    expect(isShareGameCaptureHintSilenced(storage, true)).toBe(true);
  });

  it("is not remembered on a host that does not persist hints (localhost)", () => {
    const storage = memoryStorage();
    silenceShareGameCaptureHint(storage, false);
    expect(storage.data.size).toBe(0);
    expect(isShareGameCaptureHintSilenced(storage, false)).toBe(false);
  });
});

describe("shouldShowShareCaptureNotice", () => {
  const hint = { kind: "black" as const, at: 1_000 };

  it("shows a hint nobody closed", () => {
    expect(shouldShowShareCaptureNotice({ hint, closedAt: null, silenced: false })).toBe(true);
  });

  it("a close hides THIS hint, and the next one shows again", () => {
    expect(shouldShowShareCaptureNotice({ hint, closedAt: 1_000, silenced: false })).toBe(false);
    expect(
      shouldShowShareCaptureNotice({ hint: { kind: "stalled", at: 9_000 }, closedAt: 1_000, silenced: false }),
    ).toBe(true);
  });

  it("silenced hides every hint", () => {
    expect(shouldShowShareCaptureNotice({ hint, closedAt: null, silenced: true })).toBe(false);
  });

  it("nothing to show without a hint", () => {
    expect(shouldShowShareCaptureNotice({ hint: null, closedAt: null, silenced: false })).toBe(false);
  });
});

describe("earlyEndIsHint", () => {
  it("is the first minute only", () => {
    expect(earlyEndIsHint(0, 5_000)).toBe(true);
    expect(earlyEndIsHint(0, 59_999)).toBe(true);
    expect(earlyEndIsHint(0, 60_000)).toBe(false);
    expect(earlyEndIsHint(10_000, 5_000)).toBe(false);
  });
});

describe("confirmExclusiveFullscreen", () => {
  it("is true only when the shell says exclusive fullscreen", async () => {
    const shell = (exclusiveFullscreen: boolean | null) => ({
      fullscreenAppState: async () => ({ state: "x", raw: null, exclusiveFullscreen }),
    });
    expect(await confirmExclusiveFullscreen(shell(true))).toBe(true);
    expect(await confirmExclusiveFullscreen(shell(false))).toBe(false);
    expect(await confirmExclusiveFullscreen(shell(null))).toBe(null);
  });

  it("is null in a browser, in an older shell, and when the shell fails", async () => {
    expect(await confirmExclusiveFullscreen(undefined)).toBe(null);
    expect(await confirmExclusiveFullscreen({})).toBe(null);
    expect(
      await confirmExclusiveFullscreen({
        fullscreenAppState: async () => {
          throw new Error("ipc gone");
        },
      }),
    ).toBe(null);
  });
});

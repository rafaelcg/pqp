import { describe, expect, it, vi } from "vitest";
import {
  chooseFullscreenStrategy,
  isStandaloneDisplayMode,
  lockLandscape,
  nativeVideoFullscreenAllowed,
  NATIVE_VIDEO_FULLSCREEN_KEY,
  unlockOrientation,
} from "./fullscreen";

describe("chooseFullscreenStrategy", () => {
  it("takes element fullscreen wherever it exists (desktop, Android, iPad)", () => {
    expect(
      chooseFullscreenStrategy({
        elementFullscreen: true,
        videoNativeFullscreen: true,
        hasVideo: true,
        allowNativeVideo: true,
      }),
    ).toBe("element");
  });

  it("an iPhone expands in the page unless the native player is opted in", () => {
    const iphone = {
      elementFullscreen: false,
      videoNativeFullscreen: true,
      hasVideo: true,
    };
    expect(chooseFullscreenStrategy({ ...iphone, allowNativeVideo: false })).toBe(
      "expand",
    );
    expect(chooseFullscreenStrategy({ ...iphone, allowNativeVideo: true })).toBe(
      "video",
    );
  });

  it("never hands an audio-only stage to the native player", () => {
    expect(
      chooseFullscreenStrategy({
        elementFullscreen: false,
        videoNativeFullscreen: true,
        hasVideo: false,
        allowNativeVideo: true,
      }),
    ).toBe("expand");
  });

  it("falls to expand when nothing is available", () => {
    expect(
      chooseFullscreenStrategy({
        elementFullscreen: false,
        videoNativeFullscreen: false,
        hasVideo: true,
        allowNativeVideo: true,
      }),
    ).toBe("expand");
  });
});

describe("nativeVideoFullscreenAllowed", () => {
  it("reads the opt-in key and treats hostile storage as off", () => {
    const on = { getItem: (k: string) => (k === NATIVE_VIDEO_FULLSCREEN_KEY ? "1" : null) };
    expect(nativeVideoFullscreenAllowed(on)).toBe(true);
    expect(nativeVideoFullscreenAllowed({ getItem: () => null })).toBe(false);
    expect(nativeVideoFullscreenAllowed(null)).toBe(false);
    expect(
      nativeVideoFullscreenAllowed({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBe(false);
  });
});

describe("orientation lock", () => {
  it("asks for landscape and swallows a refusal", async () => {
    const lock = vi.fn(() => Promise.reject(new Error("NotSupportedError")));
    lockLandscape({ lock });
    expect(lock).toHaveBeenCalledWith("landscape");
    await Promise.resolve();
  });

  it("is a no-op where the API is missing or throws", () => {
    expect(() => lockLandscape(undefined)).not.toThrow();
    expect(() => lockLandscape({})).not.toThrow();
    expect(() =>
      lockLandscape({
        lock: () => {
          throw new Error("sync");
        },
      }),
    ).not.toThrow();
    expect(() => unlockOrientation(undefined)).not.toThrow();
    expect(() =>
      unlockOrientation({
        unlock: () => {
          throw new Error("sync");
        },
      }),
    ).not.toThrow();
  });
});

describe("isStandaloneDisplayMode", () => {
  it("is true for navigator.standalone or the display-mode media query", () => {
    expect(isStandaloneDisplayMode({ navigatorStandalone: true })).toBe(true);
    expect(
      isStandaloneDisplayMode({
        matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" }),
      }),
    ).toBe(true);
    expect(
      isStandaloneDisplayMode({
        navigatorStandalone: false,
        matchMedia: () => ({ matches: false }),
      }),
    ).toBe(false);
    expect(isStandaloneDisplayMode({})).toBe(false);
  });
});

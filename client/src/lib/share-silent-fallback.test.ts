import { describe, expect, it, vi } from "vitest";
import {
  canRetryShareWithoutSound,
  retryShareWithoutSound,
  silentRetryOptions,
} from "./share-silent-fallback";
import type { ScreenCaptureOptions } from "./screen-capture-audio";

const audioOptions: ScreenCaptureOptions = {
  video: { frameRate: { ideal: 30, max: 30 } },
  audio: { echoCancellation: false, restrictOwnAudio: true } as MediaTrackConstraints,
  systemAudio: "include",
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
};

function named(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

function shell(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: {
      displayMedia: true,
      systemAudio: "loopback" as const,
      restrictOwnAudio: true,
      pickerOffersAudio: true,
      silentRetry: true,
      version: "0.2.7",
    },
    shareSilentRetryArm: vi.fn(async () => true),
    ...overrides,
  };
}

const fakeStream = { id: "silent" } as unknown as MediaStream;

describe("silentRetryOptions", () => {
  it("drops every way of asking for sound and keeps the picture request", () => {
    const retry = silentRetryOptions(audioOptions);
    expect(retry.audio).toBe(false);
    expect(retry.systemAudio).toBe("exclude");
    expect(retry.video).toEqual(audioOptions.video);
    expect(retry.selfBrowserSurface).toBe("exclude");
  });
});

describe("canRetryShareWithoutSound", () => {
  const base = {
    err: named("NotReadableError"),
    options: audioOptions,
    env: { isDesktopShell: true },
    desktop: shell(),
  };

  it("retries a desktop share that asked for sound and failed", () => {
    expect(canRetryShareWithoutSound(base)).toBe(true);
  });

  it("never retries in a browser, where it would open the picker again", () => {
    expect(canRetryShareWithoutSound({ ...base, env: { isDesktopShell: false } })).toBe(false);
  });

  it("never retries a cancelled picker", () => {
    expect(canRetryShareWithoutSound({ ...base, err: named("NotAllowedError") })).toBe(false);
  });

  it("never retries a request that asked for no sound", () => {
    expect(
      canRetryShareWithoutSound({ ...base, options: { ...audioOptions, audio: false } }),
    ).toBe(false);
  });

  it("needs a shell that promises silentRetry", () => {
    const old = shell({ capabilities: { ...shell().capabilities, silentRetry: undefined } });
    expect(canRetryShareWithoutSound({ ...base, desktop: old })).toBe(false);
    expect(canRetryShareWithoutSound({ ...base, desktop: null })).toBe(false);
  });

  it("ignores something thrown that is not an Error", () => {
    expect(canRetryShareWithoutSound({ ...base, err: "boom" })).toBe(false);
  });
});

describe("retryShareWithoutSound", () => {
  it("arms the shell, then asks once more without sound", async () => {
    const desktop = shell();
    const getDisplayMedia = vi.fn(async (_options: ScreenCaptureOptions) => fakeStream);
    const stream = await retryShareWithoutSound({
      err: named("NotReadableError"),
      options: audioOptions,
      env: { isDesktopShell: true },
      desktop,
      getDisplayMedia,
    });
    expect(stream).toBe(fakeStream);
    expect(desktop.shareSilentRetryArm).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia.mock.calls[0]?.[0]).toMatchObject({ audio: false, systemAudio: "exclude" });
  });

  it("asks nothing when the shell had no loopback request to retry", async () => {
    const getDisplayMedia = vi.fn(async () => fakeStream);
    const stream = await retryShareWithoutSound({
      err: named("NotReadableError"),
      options: audioOptions,
      env: { isDesktopShell: true },
      desktop: shell({ shareSilentRetryArm: vi.fn(async () => false) }),
      getDisplayMedia,
    });
    expect(stream).toBeNull();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("returns null when the arm itself throws", async () => {
    const getDisplayMedia = vi.fn(async () => fakeStream);
    const stream = await retryShareWithoutSound({
      err: named("NotReadableError"),
      options: audioOptions,
      env: { isDesktopShell: true },
      desktop: shell({
        shareSilentRetryArm: vi.fn(async () => {
          throw new Error("ipc gone");
        }),
      }),
      getDisplayMedia,
    });
    expect(stream).toBeNull();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("returns null when the silent request fails too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stream = await retryShareWithoutSound({
      err: named("NotReadableError"),
      options: audioOptions,
      env: { isDesktopShell: true },
      desktop: shell(),
      getDisplayMedia: async () => {
        throw named("NotReadableError");
      },
    });
    expect(stream).toBeNull();
    warn.mockRestore();
  });
});

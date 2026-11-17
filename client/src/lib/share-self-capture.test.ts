import { describe, expect, it } from "vitest";
import {
  readShareSurfaceHints,
  shareMayCaptureThisWindow,
  windowFillsScreen,
} from "./share-self-capture";

describe("shareMayCaptureThisWindow", () => {
  it("is true for a whole screen, in a browser or the shell", () => {
    expect(
      shareMayCaptureThisWindow({ displaySurface: "monitor", desktopApp: false }),
    ).toBe(true);
    expect(
      shareMayCaptureThisWindow({ displaySurface: "monitor", desktopApp: true }),
    ).toBe(true);
  });

  it("trusts a window or a tab, even in the shell", () => {
    for (const displaySurface of ["window", "browser"]) {
      expect(shareMayCaptureThisWindow({ displaySurface, desktopApp: true })).toBe(
        false,
      );
    }
  });

  it("reads the capturer id when the surface is absent", () => {
    expect(
      shareMayCaptureThisWindow({ label: "screen:0:0", desktopApp: false }),
    ).toBe(true);
    expect(
      shareMayCaptureThisWindow({ label: "window:77:0", desktopApp: true }),
    ).toBe(false);
  });

  it("guesses yes only in the shell when nothing is known", () => {
    expect(shareMayCaptureThisWindow({ desktopApp: true })).toBe(true);
    expect(shareMayCaptureThisWindow({ desktopApp: false })).toBe(false);
  });
});

describe("windowFillsScreen", () => {
  const screen = { width: 1920, height: 1080 };
  it("is true for a page as big as the screen", () => {
    expect(windowFillsScreen({ innerWidth: 1920, innerHeight: 1080, screen })).toBe(true);
  });
  it("is false for a maximized window that leaves the taskbar out", () => {
    expect(windowFillsScreen({ innerWidth: 1920, innerHeight: 1009, screen })).toBe(false);
  });
  it("is true for any element in fullscreen", () => {
    expect(
      windowFillsScreen({
        innerWidth: 800,
        innerHeight: 600,
        screen,
        document: { fullscreenElement: {} as Element },
      }),
    ).toBe(true);
  });
  it("is false when the screen size is unknown", () => {
    expect(
      windowFillsScreen({ innerWidth: 0, innerHeight: 0, screen: { width: 0, height: 0 } }),
    ).toBe(false);
  });
});

describe("readShareSurfaceHints", () => {
  it("never throws on a track that implements nothing", () => {
    const stream = { getVideoTracks: () => [{}] } as unknown as MediaStream;
    expect(readShareSurfaceHints(stream, true)).toEqual({
      displaySurface: null,
      label: null,
      desktopApp: true,
    });
    expect(readShareSurfaceHints(null, false).displaySurface).toBeNull();
  });
});

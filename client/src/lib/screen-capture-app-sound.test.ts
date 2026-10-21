import { describe, expect, it } from "vitest";
import { screenCaptureOptions, type ScreenCaptureEnvironment } from "./screen-capture-audio";

/*
 * The app pane's own sound (`intent.appAudio`, `lib/apps/share-audio.ts`). The picture of a pane is a capture of the
 * pqp tab, and the tab's own sound holds the call's voices, so a share that carries the app's sound asks the browser
 * for none: nothing in the picker to tick, and nothing that could come back to the people talking.
 */

const env = (over: Partial<ScreenCaptureEnvironment>): ScreenCaptureEnvironment => ({
  isDesktopShell: false,
  shellPlatform: null,
  supportsRestrictOwnAudio: true,
  osCanExcludeCallAudio: true,
  sharePickerOffersAudio: false,
  shellSystemAudio: null,
  shellRestrictOwnAudio: null,
  ...over,
});

const browser = env({});
const oldBrowser = env({ supportsRestrictOwnAudio: false, osCanExcludeCallAudio: false });
const win10Browser = env({ osCanExcludeCallAudio: false });
const windowsShell = env({
  isDesktopShell: true,
  shellPlatform: "win32",
  sharePickerOffersAudio: true,
  shellSystemAudio: "loopback",
  shellRestrictOwnAudio: true,
});
const oldShell = env({ isDesktopShell: true, shellPlatform: "win32", supportsRestrictOwnAudio: false, osCanExcludeCallAudio: false });
const macShell = env({
  isDesktopShell: true,
  shellPlatform: "darwin",
  osCanExcludeCallAudio: false,
  shellSystemAudio: "none",
  shellRestrictOwnAudio: true,
});

const appAudio = { kind: "audio" } as MediaStreamTrack;

describe("the app pane's own sound in the capture options", () => {
  it("is the baseline that went out silent in a call: a browser tab share asks for the tab's sound", () => {
    // what the pane share used to leave to the browser: the tab's sound, call voices included
    expect(screenCaptureOptions(false, browser, { preferBrowserTab: true }).audio).not.toBe(false);
  });

  it("asks the browser for no sound at all, and offers no window or machine sound either", () => {
    for (const environment of [browser, oldBrowser, win10Browser]) {
      const options = screenCaptureOptions(false, environment, { preferBrowserTab: true, appAudio });
      expect(options.audio).toBe(false);
      expect(options.systemAudio).toBe("exclude");
      expect(options.windowAudio).toBe("exclude");
    }
  });

  it("holds when the person picks a window or a screen (no tab steer): the mixer is never offered", () => {
    const options = screenCaptureOptions(false, browser, { appAudio });
    expect(options.audio).toBe(false);
    expect(options.systemAudio).toBe("exclude");
    expect(options.windowAudio).toBe("exclude");
  });

  it("asks the desktop shell for none either, whatever its picker would offer", () => {
    for (const environment of [windowsShell, oldShell, macShell]) {
      const options = screenCaptureOptions(true, environment, { appAudio });
      expect(options.audio).toBe(false);
      expect(options.systemAudio).toBe("exclude");
    }
  });

  it("changes nothing for a share that has no app sound", () => {
    expect(screenCaptureOptions(false, browser, { preferBrowserTab: true })).toEqual(
      screenCaptureOptions(false, browser, { preferBrowserTab: true, appAudio: undefined }),
    );
    expect(screenCaptureOptions(true, windowsShell).audio).not.toBe(false);
  });
});

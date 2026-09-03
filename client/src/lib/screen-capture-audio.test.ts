import { describe, expect, it } from "vitest";
import {
  capturesSystemAudio,
  screenCaptureOptions,
  shellCarriesScreenAudio,
  type ScreenCaptureEnvironment,
} from "./screen-capture-audio";

const browser: ScreenCaptureEnvironment = {
  isDesktopShell: false,
  shellPlatform: null,
  supportsRestrictOwnAudio: true,
};
const oldBrowser: ScreenCaptureEnvironment = {
  isDesktopShell: false,
  shellPlatform: null,
  supportsRestrictOwnAudio: false,
};
/** The installed v0.1.3 build on Windows: loopback is real there. */
const shell: ScreenCaptureEnvironment = {
  isDesktopShell: true,
  shellPlatform: "win32",
  supportsRestrictOwnAudio: false,
};
const newShell: ScreenCaptureEnvironment = {
  isDesktopShell: true,
  shellPlatform: "win32",
  supportsRestrictOwnAudio: true,
};
/** The same build on macOS, where no capture can carry the machine's sound. */
const macShell: ScreenCaptureEnvironment = {
  isDesktopShell: true,
  shellPlatform: "darwin",
  supportsRestrictOwnAudio: false,
};

describe("screenCaptureOptions", () => {
  it("does not ask for the machine's audio unless the user opted in", () => {
    // The whole bug in one assertion. `include` is what put every participant's
    // voice back into the call on a Windows whole-screen share.
    expect(screenCaptureOptions(false, browser).systemAudio).toBe("exclude");
  });

  it("asks for it when the user opted in", () => {
    expect(screenCaptureOptions(true, browser).systemAudio).toBe("include");
  });

  it("still requests audio by default, because tab audio is the clean path", () => {
    // `systemAudio: "exclude"` is scoped to monitor surfaces by the spec, so a
    // Chrome tab share keeps handing over its own sound. Verified on Chrome 151
    // against a real tab capture; this pins the request that makes it possible.
    const audio = screenCaptureOptions(false, browser).audio;
    expect(audio).not.toBe(false);
    expect(audio).toMatchObject({ echoCancellation: false });
  });

  it("keeps the mic processing chain off in both modes", () => {
    for (const opted of [false, true]) {
      expect(screenCaptureOptions(opted, browser).audio).toMatchObject({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
    }
  });

  it("adds restrictOwnAudio where the browser knows it", () => {
    expect(screenCaptureOptions(true, browser).audio).toMatchObject({
      restrictOwnAudio: true,
    });
  });

  it("omits restrictOwnAudio where it is unknown", () => {
    // Chrome shipped it on desktop 141. Sending a constraint an older engine
    // does not recognise is a risk taken for nothing.
    expect(screenCaptureOptions(true, oldBrowser).audio).not.toHaveProperty(
      "restrictOwnAudio",
    );
  });

  it("asks the desktop shell for no audio at all until the user opts in", () => {
    // The shell reads `audioRequested` and answers Windows loopback when it is
    // true. False is therefore the only lever the web client has over an
    // already-installed v0.1.3 build, and it is the one that matters.
    expect(screenCaptureOptions(false, shell).audio).toBe(false);
  });

  it("lets the shell have loopback once the user opts in", () => {
    expect(screenCaptureOptions(true, shell).audio).toMatchObject({
      echoCancellation: false,
    });
  });

  it("asks a current shell to strip its own playback", () => {
    // Electron 43.4+ remaps Windows `"loopback"` to `loopbackWithoutChrome`
    // only when this constraint is on the getDisplayMedia request.
    expect(screenCaptureOptions(true, newShell).audio).toMatchObject({
      restrictOwnAudio: true,
    });
  });

  it("asks a macOS shell for no audio even when the user opted in", () => {
    // The 3 Sep 2026 report: ticking the box made the picker close and nothing
    // happen. `useSystemPicker: true` means our video-only handler is skipped,
    // the request reaches Chromium intact, and macOS has no system audio to
    // give — which rejects the capture whole, video included.
    expect(screenCaptureOptions(true, macShell).audio).toBe(false);
    expect(screenCaptureOptions(true, macShell).systemAudio).toBe("exclude");
  });

  it("knows which shells can carry sound at all", () => {
    expect(shellCarriesScreenAudio(shell)).toBe(true);
    expect(shellCarriesScreenAudio(macShell)).toBe(false);
    // A browser is not a shell, and the answer here is about the shell only:
    // tab audio is a browser's own path and is never decided by this.
    expect(shellCarriesScreenAudio(browser)).toBe(false);
  });

  it("never offers our own tab as a surface", () => {
    expect(screenCaptureOptions(true, browser).selfBrowserSurface).toBe(
      "exclude",
    );
  });

  it("keeps the 1080p30 video ceiling", () => {
    expect(screenCaptureOptions(false, browser).video).toMatchObject({
      frameRate: { ideal: 30, max: 30 },
      width: { max: 1920 },
      height: { max: 1080 },
    });
  });
});

describe("capturesSystemAudio", () => {
  it("is true for a monitor share that carries sound", () => {
    // The one shape that can put everybody's voices back into the room.
    expect(
      capturesSystemAudio({ displaySurface: "monitor", hasAudio: true }),
    ).toBe(true);
  });

  it("is false for a silent monitor share", () => {
    expect(
      capturesSystemAudio({ displaySurface: "monitor", hasAudio: false }),
    ).toBe(false);
  });

  it("is false for a tab share with sound", () => {
    // The recommended, working case. A tab capture contains that tab and
    // nothing else, so the call is not in it.
    expect(
      capturesSystemAudio({ displaySurface: "browser", hasAudio: true }),
    ).toBe(false);
  });

  it("is false for a window share with sound", () => {
    expect(
      capturesSystemAudio({ displaySurface: "window", hasAudio: true }),
    ).toBe(false);
  });

  it("is false when the browser hides which surface was picked", () => {
    // Safari and Firefox omit `displaySurface`, and neither can capture system
    // audio. A warning there would be false, and a false warning is how a true
    // one gets ignored.
    expect(capturesSystemAudio({ hasAudio: true })).toBe(false);
    expect(
      capturesSystemAudio({ displaySurface: null, hasAudio: true }),
    ).toBe(false);
  });
});

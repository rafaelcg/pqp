import { describe, expect, it } from "vitest";
import {
  capturesSystemAudio,
  needsShareAudioPrompt,
  offersBrowserSystemAudio,
  offersShellSystemAudio,
  screenCaptureOptions,
  shareStreamHasAudio,
  shellCarriesScreenAudio,
  type ScreenCaptureEnvironment,
} from "./screen-capture-audio";

const browser: ScreenCaptureEnvironment = {
  isDesktopShell: false,
  shellPlatform: null,
  supportsRestrictOwnAudio: true,
  sharePickerOffersAudio: false,
};
const oldBrowser: ScreenCaptureEnvironment = {
  isDesktopShell: false,
  shellPlatform: null,
  supportsRestrictOwnAudio: false,
  sharePickerOffersAudio: false,
};
/** The installed v0.1.3 build on Windows: loopback is real there. */
const shell: ScreenCaptureEnvironment = {
  isDesktopShell: true,
  shellPlatform: "win32",
  supportsRestrictOwnAudio: false,
  sharePickerOffersAudio: false,
};
const newShell: ScreenCaptureEnvironment = {
  isDesktopShell: true,
  shellPlatform: "win32",
  supportsRestrictOwnAudio: true,
  sharePickerOffersAudio: false,
};
const pickerShell: ScreenCaptureEnvironment = {
  isDesktopShell: true,
  shellPlatform: "win32",
  supportsRestrictOwnAudio: true,
  sharePickerOffersAudio: true,
};
/** The same build on macOS, where no capture can carry the machine's sound. */
const macShell: ScreenCaptureEnvironment = {
  isDesktopShell: true,
  shellPlatform: "darwin",
  supportsRestrictOwnAudio: false,
  sharePickerOffersAudio: false,
};

describe("screenCaptureOptions", () => {
  it("lets Chrome offer system audio when it can strip the call out", () => {
    // One checkbox, in Chrome's picker. `include` is what unlocks that box;
    // `restrictOwnAudio` is what keeps the 23 Aug 2026 echo from coming back.
    expect(screenCaptureOptions(false, browser).systemAudio).toBe("include");
    expect(screenCaptureOptions(false, browser).audio).toMatchObject({
      restrictOwnAudio: true,
    });
  });

  it("keeps the machine's mixer off on a browser that cannot strip the call", () => {
    expect(screenCaptureOptions(true, oldBrowser).systemAudio).toBe("exclude");
  });

  it("still includes when the caller also opted in", () => {
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
    expect(screenCaptureOptions(false, newShell).audio).toBe(false);
  });

  it("lets a current shell have loopback once the user opts in", () => {
    expect(screenCaptureOptions(true, newShell).audio).toMatchObject({
      echoCancellation: false,
      restrictOwnAudio: true,
    });
  });

  it("refuses loopback on a v0.1.3 shell even when the page opted in", () => {
    // That build cannot strip its own playback. Offering the tap is offering
    // the echo, so the page never asks.
    expect(screenCaptureOptions(true, shell).audio).toBe(false);
  });

  it("asks a picker-capable shell for audio so the picker can attach it", () => {
    // The box lives in the picker. The page has to request audio or Chromium
    // will ignore a loopback track the handler adds after the fact.
    expect(screenCaptureOptions(false, pickerShell).audio).toMatchObject({
      restrictOwnAudio: true,
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
      resizeMode: "crop-and-scale",
    });
  });

  it("caps capture at the picker's size, not 4K", () => {
    expect(
      screenCaptureOptions(false, browser, {
        maxWidth: 1280,
        maxHeight: 720,
        maxFrameRate: 30,
      }).video,
    ).toMatchObject({
      width: { max: 1280 },
      height: { max: 720 },
      frameRate: { ideal: 30, max: 30 },
    });
    expect(
      screenCaptureOptions(false, browser, {
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
      }).video,
    ).toMatchObject({
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { ideal: 60, max: 60 },
    });
  });

  it("asks for 60 fps only when the caller opted the HLS rung in", () => {
    expect(
      screenCaptureOptions(false, browser, { maxFrameRate: 60 }).video,
    ).toMatchObject({
      frameRate: { ideal: 60, max: 60 },
    });
    expect(
      screenCaptureOptions(false, browser, {
        preferBrowserTab: true,
        maxFrameRate: 60,
      }).video,
    ).toMatchObject({
      frameRate: { ideal: 60, max: 60 },
    });
  });

  it("steers a Watch party toward a tab and that tab's sound", () => {
    // The product meaning of Watch party: share the player tab, with its
    // sound, not the whole desktop. System audio is the echo path and stays
    // off even if the caller also passed the opt-in.
    const options = screenCaptureOptions(true, browser, {
      preferBrowserTab: true,
    });
    expect(options.systemAudio).toBe("exclude");
    expect(options.preferCurrentTab).toBeUndefined();
    expect(options.monitorTypeSurfaces).toBe("exclude");
    expect(options.selfBrowserSurface).toBe("exclude");
    expect(options.video).toMatchObject({ displaySurface: "browser" });
    expect(options.audio).not.toBe(false);
    expect(options.audio).toMatchObject({ echoCancellation: false });
  });

  it("never pairs preferCurrentTab with selfBrowserSurface exclude", () => {
    // Chrome rejects that pair with TypeError before the picker opens, then
    // startScreenShare retries `{ video: true }` and every Watch party becomes
    // a silent share. The valid tab steer is displaySurface + hide monitors.
    for (const intent of [{}, { preferBrowserTab: true }] as const) {
      const options = screenCaptureOptions(true, browser, intent);
      if (options.preferCurrentTab === true) {
        expect(options.selfBrowserSurface).not.toBe("exclude");
      }
      expect(options.selfBrowserSurface).toBe("exclude");
      expect(options.preferCurrentTab).toBeUndefined();
    }
  });

  it("asks for the cursor the person wants, in every environment", () => {
    // The constraint is spec-shaped and unconditional: an unknown dictionary
    // member is dropped by the bindings, so asking costs nothing and the day
    // an engine implements it every client already asked correctly. It must
    // not depend on the shell, on the platform, or on the audio opt-in, all of
    // which decide entirely different parts of this request.
    for (const env of [browser, oldBrowser, shell, newShell, macShell]) {
      for (const shareSystemAudio of [false, true]) {
        expect(
          screenCaptureOptions(shareSystemAudio, env, { hideCursor: true })
            .video,
        ).toMatchObject({ cursor: "never" });
        expect(
          screenCaptureOptions(shareSystemAudio, env, { hideCursor: false })
            .video,
        ).toMatchObject({ cursor: "always" });
      }
    }
  });

  it("shows the cursor when nobody said otherwise", () => {
    // A missing preference is a presenter, not a viewer: losing the pointer
    // you are pointing with is the expensive way to be wrong.
    expect(screenCaptureOptions(false, browser).video).toMatchObject({
      cursor: "always",
    });
  });

  it("carries the cursor preference into a Watch party tab share", () => {
    // A tab has no pointer in it either way, but the request still has to say
    // what was wanted: the surface is only known after the picker closes, so
    // the constraint cannot be conditional on it.
    expect(
      screenCaptureOptions(true, browser, {
        preferBrowserTab: true,
        hideCursor: true,
      }).video,
    ).toMatchObject({ displaySurface: "browser", cursor: "never" });
  });

  it("does not steer a normal share toward a tab", () => {
    const options = screenCaptureOptions(false, browser);
    expect(options.preferCurrentTab).toBeUndefined();
    expect(options.monitorTypeSurfaces).toBeUndefined();
    expect(options.video).not.toHaveProperty("displaySurface");
  });
});

describe("where the audio checkbox lives", () => {
  it("lets Chrome show its own box, and not an old browser", () => {
    expect(offersBrowserSystemAudio(browser)).toBe(true);
    expect(offersBrowserSystemAudio(oldBrowser)).toBe(false);
    expect(offersBrowserSystemAudio(browser, { preferBrowserTab: true })).toBe(
      false,
    );
  });

  it("lets a current Windows shell offer computer audio", () => {
    expect(offersShellSystemAudio(newShell)).toBe(true);
    expect(offersShellSystemAudio(pickerShell)).toBe(true);
    expect(offersShellSystemAudio(shell)).toBe(false);
    expect(offersShellSystemAudio(macShell)).toBe(false);
    expect(offersShellSystemAudio(browser)).toBe(false);
  });

  it("prompts in the page only when the picker cannot ask yet", () => {
    expect(needsShareAudioPrompt(newShell)).toBe(true);
    expect(needsShareAudioPrompt(pickerShell)).toBe(false);
    expect(needsShareAudioPrompt(shell)).toBe(false);
    expect(needsShareAudioPrompt(browser)).toBe(false);
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
describe("shareStreamHasAudio", () => {
  it("is false when the share arrived with no audio track", () => {
    // The whole reason this exists: the viewer of a silent share used to be
    // told nothing and had to ask in chat.
    expect(shareStreamHasAudio([])).toBe(false);
  });

  it("is true for a live audio track", () => {
    expect(shareStreamHasAudio([{ readyState: "live" }])).toBe(true);
  });

  it("does not count a track the presenter already stopped", () => {
    expect(shareStreamHasAudio([{ readyState: "ended" }])).toBe(false);
  });

  it("counts a track whose readyState the engine does not report", () => {
    // Absent is not "ended". Guessing silence over a share that is audible is
    // the worse of the two mistakes: it sends somebody to ask the presenter to
    // fix a thing that is not broken.
    expect(shareStreamHasAudio([{}])).toBe(true);
  });

  it("is true when one of several tracks is still live", () => {
    expect(
      shareStreamHasAudio([{ readyState: "ended" }, { readyState: "live" }]),
    ).toBe(true);
  });
});

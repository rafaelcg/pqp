import { afterEach, describe, expect, it } from "vitest";
import { en, setActiveCatalogue } from "@/lib/i18n";
import {
  canShareScreenAudio,
  detectFullscreenMode,
  screenShareUnavailableMessage,
  screenShareUnavailableReason,
  supportsAudioOutputRouting,
  supportsScreenShare,
} from "./capabilities";

// The catalogue is module state shared with the running app; a test that leaves
// a language set decides the outcome of whatever runs after it.
afterEach(() => setActiveCatalogue(undefined));

/** What `navigator.mediaDevices` looks like on iOS Safari: no getDisplayMedia. */
const IOS_MEDIA_DEVICES = {
  getUserMedia: () => Promise.resolve(),
  enumerateDevices: () => Promise.resolve([]),
};

const DESKTOP_MEDIA_DEVICES = {
  ...IOS_MEDIA_DEVICES,
  getDisplayMedia: () => Promise.resolve(),
};

describe("screen share capability", () => {
  it("is supported where getDisplayMedia exists", () => {
    expect(
      supportsScreenShare({
        mediaDevices: DESKTOP_MEDIA_DEVICES,
        isSecureContext: true,
      }),
    ).toBe(true);
    expect(
      screenShareUnavailableReason({
        mediaDevices: DESKTOP_MEDIA_DEVICES,
        isSecureContext: true,
      }),
    ).toBeNull();
  });

  it("is unsupported on iOS Safari, and that is a platform limit, not a failure", () => {
    const probe = { mediaDevices: IOS_MEDIA_DEVICES, isSecureContext: true };
    expect(supportsScreenShare(probe)).toBe(false);
    expect(screenShareUnavailableReason(probe)).toBe("no-api");
    // The wording must stay matter-of-fact: this string is rendered as muted
    // helper text, never as an alert.
    expect(screenShareUnavailableMessage("no-api")).toBe(
      "Screen sharing isn't supported by this browser.",
    );
  });

  it("distinguishes an insecure origin from a missing platform feature", () => {
    expect(
      screenShareUnavailableReason({
        mediaDevices: undefined,
        isSecureContext: false,
      }),
    ).toBe("insecure-context");
    expect(screenShareUnavailableMessage("insecure-context")).toContain(
      "HTTPS",
    );
  });

  it("treats a non-callable getDisplayMedia as absent", () => {
    expect(
      supportsScreenShare({
        mediaDevices: { getDisplayMedia: undefined },
        isSecureContext: true,
      }),
    ).toBe(false);
    expect(
      supportsScreenShare({ mediaDevices: null, isSecureContext: true }),
    ).toBe(false);
  });
});

describe("screen share message translation", () => {
  it("reads the wording from the active catalogue", () => {
    setActiveCatalogue({
      "voice.screenShareUnsupported": "Este navegador não faz isso.",
    });
    expect(screenShareUnavailableMessage("no-api")).toBe(
      "Este navegador não faz isso.",
    );
  });

  it("falls back to English for a key the translation omits", () => {
    // The whole point of `Partial<Messages>`: half a catalogue renders half in
    // English rather than rendering a key name or a blank.
    setActiveCatalogue({
      "voice.screenShareUnsupported": "Este navegador não faz isso.",
    });
    const insecure = screenShareUnavailableMessage("insecure-context");
    expect(insecure).toBe(en["voice.screenShareInsecure"]);
    expect(insecure).not.toBe("voice.screenShareInsecure");
    expect(insecure).not.toBe("");
  });

  it("is resolved per call, not frozen at import time", () => {
    // The catalogue chunk is fetched after this module is imported, so a value
    // captured in a module-level constant would be English for the session.
    const before = screenShareUnavailableMessage("no-api");
    setActiveCatalogue({ "voice.screenShareUnsupported": "Depois." });
    expect(screenShareUnavailableMessage("no-api")).toBe("Depois.");
    expect(before).toBe(en["voice.screenShareUnsupported"]);
  });
});

describe("fullscreen capability", () => {
  it("uses the standard API when the document allows it", () => {
    expect(
      detectFullscreenMode({
        documentFullscreenEnabled: true,
        requestFullscreen: () => Promise.resolve(),
      }),
    ).toBe("element");
  });

  it("uses element fullscreen on Safari before 16.4, which only has the prefix", () => {
    // The bug this pins: with only the standard name probed, a Mac on Safari
    // 16.3 reported "no element fullscreen" and fell through to the fallback,
    // so a machine with perfectly good OS fullscreen never used it.
    expect(
      detectFullscreenMode({
        documentFullscreenEnabled: undefined,
        requestFullscreen: undefined,
        webkitRequestFullscreen: () => Promise.resolve(),
      }),
    ).toBe("element");
  });

  it("expands in the page on an iPhone rather than using the native player", () => {
    // The bug this pins, reported from a real iPhone on 22 Aug 2026. iOS
    // Safari's only native fullscreen hands the <video> to the OS media
    // player, which renders files and HLS and CANNOT render a MediaStream: it
    // went fullscreen and showed black while the call's audio kept playing
    // from its own <audio> sink. No error, no crash, no picture. So the
    // fallback must never be the native path, even though the method exists.
    expect(
      detectFullscreenMode({
        documentFullscreenEnabled: undefined,
        requestFullscreen: undefined,
        webkitRequestFullscreen: undefined,
      }),
    ).toBe("expand");
  });

  it("expands when the document forbids real fullscreen", () => {
    // An iframe without allowfullscreen. There is no longer a "none": the
    // in-page expand needs no permission from anybody.
    expect(detectFullscreenMode({})).toBe("expand");
    expect(
      detectFullscreenMode({
        documentFullscreenEnabled: false,
        requestFullscreen: () => Promise.resolve(),
      }),
    ).toBe("expand");
  });
});

describe("audio output routing capability", () => {
  it("needs both setSinkId and a selectable output device", () => {
    expect(
      supportsAudioOutputRouting({
        setSinkId: () => Promise.resolve(),
        outputDeviceCount: 2,
      }),
    ).toBe(true);
  });

  it("is false on iOS Safari, which has setSinkId but enumerates no outputs", () => {
    expect(
      supportsAudioOutputRouting({
        setSinkId: () => Promise.resolve(),
        outputDeviceCount: 0,
      }),
    ).toBe(false);
  });

  it("is false on Android browsers, which have no setSinkId at all", () => {
    expect(
      supportsAudioOutputRouting({
        setSinkId: undefined,
        outputDeviceCount: 3,
      }),
    ).toBe(false);
  });
});

describe("canShareScreenAudio", () => {
  it("is false in a desktop shell that cannot capture sound", () => {
    // macOS and Linux shells answer every request with video alone, so the
    // toggle arms nothing. It used to be worse than nothing: the system picker
    // skips our handler, the request reached Chromium intact, and an audio
    // request macOS cannot honour rejected the whole capture (3 Sep 2026).
    expect(
      canShareScreenAudio({
        isDesktopShell: true,
        shellPlatform: "darwin",
        supportsRestrictOwnAudio: false,
      }),
    ).toBe(false);
  });

  it("is true in the Windows shell, where loopback is real", () => {
    expect(
      canShareScreenAudio({
        isDesktopShell: true,
        shellPlatform: "win32",
        supportsRestrictOwnAudio: true,
      }),
    ).toBe(true);
  });

  it("is true in any browser, because there it governs tab audio", () => {
    expect(
      canShareScreenAudio({
        isDesktopShell: false,
        shellPlatform: null,
        supportsRestrictOwnAudio: false,
      }),
    ).toBe(true);
  });
});

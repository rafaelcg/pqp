import { describe, expect, it } from "vitest";
import {
  detectFullscreenMode,
  screenShareUnavailableMessage,
  screenShareUnavailableReason,
  supportsAudioOutputRouting,
  supportsScreenShare,
} from "./capabilities";

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

describe("fullscreen capability", () => {
  it("uses the standard API when the document allows it", () => {
    expect(
      detectFullscreenMode({
        documentFullscreenEnabled: true,
        requestFullscreen: () => Promise.resolve(),
      }),
    ).toBe("element");
  });

  it("falls back to iOS Safari's video-only fullscreen", () => {
    // iOS Safari: no Element.requestFullscreen, no document.fullscreenEnabled,
    // but <video> can go fullscreen through the webkit method.
    expect(
      detectFullscreenMode({
        documentFullscreenEnabled: undefined,
        requestFullscreen: undefined,
        webkitEnterFullscreen: () => {},
      }),
    ).toBe("video");
  });

  it("reports none when nothing can go fullscreen, so the control can be hidden", () => {
    expect(detectFullscreenMode({})).toBe("none");
    expect(
      detectFullscreenMode({
        documentFullscreenEnabled: false,
        requestFullscreen: () => Promise.resolve(),
      }),
    ).toBe("none");
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

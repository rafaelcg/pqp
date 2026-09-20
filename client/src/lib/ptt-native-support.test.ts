import { describe, expect, it } from "vitest";
import { pttHintMessageKey } from "./ptt-native-support";

describe("pttHintMessageKey", () => {
  it("web (not desktop) always gets the browser-limited hint, whatever else is true", () => {
    expect(
      pttHintMessageKey({
        isDesktop: false,
        platformSupported: false,
        platformReason: "wayland",
        permission: "denied",
      }),
    ).toBe("settings.voice.pttHint");
  });

  it("desktop, everything fine, gets the native hint", () => {
    expect(
      pttHintMessageKey({
        isDesktop: true,
        platformSupported: true,
        permission: "not-required",
      }),
    ).toBe("settings.voice.pttHintDesktopNative");

    expect(
      pttHintMessageKey({
        isDesktop: true,
        platformSupported: true,
        permission: "granted",
      }),
    ).toBe("settings.voice.pttHintDesktopNative");
  });

  it("desktop, unknown permission, still optimistic (native) rather than alarming", () => {
    expect(
      pttHintMessageKey({
        isDesktop: true,
        platformSupported: true,
        permission: "unknown",
      }),
    ).toBe("settings.voice.pttHintDesktopNative");
  });

  it("Wayland wins over an unrelated permission reading", () => {
    expect(
      pttHintMessageKey({
        isDesktop: true,
        platformSupported: false,
        platformReason: "wayland",
        permission: "not-required",
      }),
    ).toBe("settings.voice.pttHintDesktopWayland");
  });

  it("a definite macOS denial gets the permission hint", () => {
    expect(
      pttHintMessageKey({
        isDesktop: true,
        platformSupported: true,
        permission: "denied",
      }),
    ).toBe("settings.voice.pttHintDesktopDenied");
  });

  it("Wayland takes priority over denied when somehow both are true", () => {
    expect(
      pttHintMessageKey({
        isDesktop: true,
        platformSupported: false,
        platformReason: "wayland",
        permission: "denied",
      }),
    ).toBe("settings.voice.pttHintDesktopWayland");
  });

  it("an unsupported platform with no Wayland reason still falls through to the native hint (nothing more specific to say)", () => {
    expect(
      pttHintMessageKey({
        isDesktop: true,
        platformSupported: false,
        platformReason: "platform",
        permission: "not-required",
      }),
    ).toBe("settings.voice.pttHintDesktopNative");
  });
});

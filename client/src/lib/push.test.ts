import { describe, expect, it } from "vitest";
import {
  resolvePushAvailability,
  urlBase64ToUint8Array,
  type PushEnvironment,
} from "./push";

/**
 * The pure halves of the push client: the availability matrix — which decides
 * whether the settings screen shows a button, an install instruction, or an
 * honest "cannot" — and the VAPID key decoding every subscribe call rides on.
 * The browser-API halves need a real browser and are exercised on-device.
 */

function env(overrides: Partial<PushEnvironment>): PushEnvironment {
  return {
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    isIos: false,
    standalone: false,
    ...overrides,
  };
}

describe("resolvePushAvailability", () => {
  it("is available in a capable desktop/Android browser", () => {
    expect(resolvePushAvailability(env({}))).toBe("available");
  });

  it("asks for the install on iOS in a plain tab — even though the APIs are absent there", () => {
    expect(
      resolvePushAvailability(
        env({ isIos: true, hasPushManager: false, standalone: false }),
      ),
    ).toBe("needs-install");
  });

  it("is available on iOS once installed and capable", () => {
    expect(resolvePushAvailability(env({ isIos: true, standalone: true }))).toBe(
      "available",
    );
  });

  it("is unsupported without a service worker, PushManager, or Notification", () => {
    expect(resolvePushAvailability(env({ hasServiceWorker: false }))).toBe(
      "unsupported",
    );
    expect(resolvePushAvailability(env({ hasPushManager: false }))).toBe(
      "unsupported",
    );
    expect(resolvePushAvailability(env({ hasNotification: false }))).toBe(
      "unsupported",
    );
  });

  it("an installed iOS app that still lacks PushManager (iOS < 16.4) is unsupported, not needs-install", () => {
    expect(
      resolvePushAvailability(
        env({ isIos: true, standalone: true, hasPushManager: false }),
      ),
    ).toBe("unsupported");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes URL-safe base64 with missing padding", () => {
    // "hello" → aGVsbG8 (unpadded)
    expect([...urlBase64ToUint8Array("aGVsbG8")]).toEqual([
      104, 101, 108, 108, 111,
    ]);
  });

  it("maps the URL-safe alphabet back to the bytes standard base64 would give", () => {
    // 0xfb 0xef 0xff encodes as "++//" in standard base64, "--__" URL-safe.
    expect([...urlBase64ToUint8Array("--__")]).toEqual([251, 239, 255]);
  });

  it("round-trips a realistic 65-byte uncompressed P-256 key length", () => {
    const bytes = new Uint8Array(65).map((_, i) => i);
    let binary = "";
    for (const b of bytes) {
      binary += String.fromCharCode(b);
    }
    const base64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect([...urlBase64ToUint8Array(base64)]).toEqual([...bytes]);
  });
});

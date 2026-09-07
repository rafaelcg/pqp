import { describe, expect, it } from "vitest";
import { chooseHlsEngine, isAutoplayRefusal } from "./hls-playback";

describe("chooseHlsEngine", () => {
  it("prefers hls.js when Chrome claims native HLS but has MSE", () => {
    // Chrome 152 / macOS: canPlayType says "maybe", the native path then
    // never reaches loadedmetadata. This is the staging bug.
    expect(chooseHlsEngine({ nativeHls: "maybe", mseSupported: true })).toBe(
      "hlsjs",
    );
  });

  it("prefers hls.js on desktop Safari, which has both", () => {
    expect(
      chooseHlsEngine({ nativeHls: "probably", mseSupported: true }),
    ).toBe("hlsjs");
  });

  it("falls back to the native player where there is no MSE at all", () => {
    // Older iPhone Safari.
    expect(chooseHlsEngine({ nativeHls: "maybe", mseSupported: false })).toBe(
      "native",
    );
  });

  it("gives up when neither exists", () => {
    expect(chooseHlsEngine({ nativeHls: "", mseSupported: false })).toBe(
      "none",
    );
  });
});

describe("isAutoplayRefusal", () => {
  it("recognises the gesture refusal and nothing else", () => {
    const refused = Object.assign(new Error("no gesture"), {
      name: "NotAllowedError",
    });
    expect(isAutoplayRefusal(refused)).toBe(true);
    expect(isAutoplayRefusal(new Error("decode"))).toBe(false);
    expect(isAutoplayRefusal(null)).toBe(false);
  });
});

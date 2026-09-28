import { afterEach, describe, expect, it } from "vitest";
import { resetFeatureFlagsForTests } from "./flags.js";
import { shareConfigForServer } from "./share-config.js";

describe("shareConfigForServer", () => {
  afterEach(() => {
    delete process.env.DESKTOP_SHARE_AUDIO_NATIVE;
    resetFeatureFlagsForTests();
  });

  it("keeps native desktop share audio off by default", () => {
    expect(shareConfigForServer(null)).toEqual({ desktopShareAudioNative: false });
  });

  it("follows the environment default, exact word only", () => {
    process.env.DESKTOP_SHARE_AUDIO_NATIVE = "true";
    expect(shareConfigForServer(null).desktopShareAudioNative).toBe(true);
    process.env.DESKTOP_SHARE_AUDIO_NATIVE = "TRUE";
    expect(shareConfigForServer(null).desktopShareAudioNative).toBe(false);
  });

  it("reads a malformed server id as no server rather than failing", () => {
    process.env.DESKTOP_SHARE_AUDIO_NATIVE = "true";
    expect(shareConfigForServer("not-a-uuid").desktopShareAudioNative).toBe(true);
    expect(
      shareConfigForServer("7a0b3f3e-2f55-4c1e-9f3a-8d2c1b0a9e11").desktopShareAudioNative,
    ).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { resetFeatureFlagsForTests } from "./flags.js";
import { shareConfigForServer } from "./share-config.js";

describe("shareConfigForServer", () => {
  afterEach(() => {
    delete process.env.DESKTOP_SHARE_AUDIO_NATIVE;
    delete process.env.SHARE_HIGH_MOTION_GUARD;
    delete process.env.SHARE_GAME_CAPTURE_HINT;
    resetFeatureFlagsForTests();
  });

  it("keeps native desktop share audio, the high-motion guard and the game capture hint off by default", () => {
    expect(shareConfigForServer(null)).toEqual({
      desktopShareAudioNative: false,
      shareHighMotionGuard: false,
      shareGameCaptureHint: false,
    });
  });

  it("reads the game capture hint from its own variable, exact word only", () => {
    process.env.SHARE_GAME_CAPTURE_HINT = "true";
    expect(shareConfigForServer(null).shareGameCaptureHint).toBe(true);
    expect(shareConfigForServer(null).shareHighMotionGuard).toBe(false);
    process.env.SHARE_GAME_CAPTURE_HINT = "1";
    expect(shareConfigForServer(null).shareGameCaptureHint).toBe(false);
  });

  it("follows the environment default, exact word only", () => {
    process.env.DESKTOP_SHARE_AUDIO_NATIVE = "true";
    expect(shareConfigForServer(null).desktopShareAudioNative).toBe(true);
    process.env.DESKTOP_SHARE_AUDIO_NATIVE = "TRUE";
    expect(shareConfigForServer(null).desktopShareAudioNative).toBe(false);
  });

  it("reads the high-motion guard from its own variable, exact word only", () => {
    process.env.SHARE_HIGH_MOTION_GUARD = "true";
    expect(shareConfigForServer(null).shareHighMotionGuard).toBe(true);
    // The two switches are independent.
    expect(shareConfigForServer(null).desktopShareAudioNative).toBe(false);
    process.env.SHARE_HIGH_MOTION_GUARD = "yes";
    expect(shareConfigForServer(null).shareHighMotionGuard).toBe(false);
  });

  it("reads a malformed server id as no server rather than failing", () => {
    process.env.DESKTOP_SHARE_AUDIO_NATIVE = "true";
    expect(shareConfigForServer("not-a-uuid").desktopShareAudioNative).toBe(true);
    expect(
      shareConfigForServer("7a0b3f3e-2f55-4c1e-9f3a-8d2c1b0a9e11").desktopShareAudioNative,
    ).toBe(true);
  });
});

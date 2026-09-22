import { describe, expect, it } from "vitest";
import {
  MUSIC_DUCK_ATTACK_MS,
  MUSIC_DUCK_RELEASE_MS,
  MUSIC_DUCK_TARGET,
  duckGain,
  duckedMusicVolume,
  musicShouldDuck,
  stepDuckGain,
} from "./music-duck";

describe("stepDuckGain", () => {
  it("attacks from 1 to 0.35 over 200 ms", () => {
    expect(stepDuckGain(1, true, MUSIC_DUCK_ATTACK_MS / 2)).toBeCloseTo(
      (1 + MUSIC_DUCK_TARGET) / 2,
    );
    expect(stepDuckGain(1, true, MUSIC_DUCK_ATTACK_MS)).toBe(MUSIC_DUCK_TARGET);
    expect(stepDuckGain(1, true, MUSIC_DUCK_ATTACK_MS * 4)).toBe(MUSIC_DUCK_TARGET);
  });

  it("releases from 0.35 to 1 over 800 ms", () => {
    const mid = stepDuckGain(MUSIC_DUCK_TARGET, false, MUSIC_DUCK_RELEASE_MS / 2);
    expect(mid).toBeCloseTo((1 + MUSIC_DUCK_TARGET) / 2);
    expect(stepDuckGain(MUSIC_DUCK_TARGET, false, MUSIC_DUCK_RELEASE_MS)).toBe(1);
  });

  it("re-triggers during release from the current gain", () => {
    const duringRelease = stepDuckGain(
      MUSIC_DUCK_TARGET,
      false,
      MUSIC_DUCK_RELEASE_MS / 2,
    );
    expect(duringRelease).toBeGreaterThan(MUSIC_DUCK_TARGET);
    expect(duringRelease).toBeLessThan(1);
    const retriggered = stepDuckGain(duringRelease, true, MUSIC_DUCK_ATTACK_MS / 2);
    expect(retriggered).toBeLessThan(duringRelease);
    expect(retriggered).toBeGreaterThan(MUSIC_DUCK_TARGET);
    expect(stepDuckGain(duringRelease, true, MUSIC_DUCK_ATTACK_MS)).toBe(
      MUSIC_DUCK_TARGET,
    );
  });
});

describe("duckGain", () => {
  it("matches the stepper for a fresh attack and release", () => {
    expect(duckGain(200, 0, null)).toBe(MUSIC_DUCK_TARGET);
    expect(duckGain(800, null, 0)).toBe(1);
  });

  it("re-triggers during release without jumping back to 1", () => {
    const edge = duckGain(400, null, 0);
    expect(edge).toBeCloseTo((1 + MUSIC_DUCK_TARGET) / 2);
    expect(duckGain(400, 400, null, edge)).toBeCloseTo(edge);
    expect(duckGain(600, 400, null, edge)).toBe(MUSIC_DUCK_TARGET);
  });
});

describe("duckedMusicVolume", () => {
  it("scales the slider by gain and never treats mute as zero", () => {
    expect(duckedMusicVolume(40, MUSIC_DUCK_TARGET)).toBe(14);
    expect(duckedMusicVolume(40, 1)).toBe(40);
    expect(duckedMusicVolume(200, 1)).toBe(100);
  });
});

describe("musicShouldDuck", () => {
  it("ducks for remote speech or a live local gate, never when deafened", () => {
    expect(
      musicShouldDuck({
        duckEnabled: true,
        deafened: false,
        speakingPeerCount: 1,
        transmitting: false,
      }),
    ).toBe(true);
    expect(
      musicShouldDuck({
        duckEnabled: true,
        deafened: false,
        speakingPeerCount: 0,
        transmitting: true,
      }),
    ).toBe(true);
    expect(
      musicShouldDuck({
        duckEnabled: true,
        deafened: true,
        speakingPeerCount: 2,
        transmitting: true,
      }),
    ).toBe(false);
    expect(
      musicShouldDuck({
        duckEnabled: false,
        deafened: false,
        speakingPeerCount: 1,
        transmitting: true,
      }),
    ).toBe(false);
  });
});

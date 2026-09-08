import { describe, expect, it } from "vitest";
import {
  DEFAULT_HLS_VOLUME,
  applyMuteToggle,
  applySliderChange,
  clampVolume,
  effectiveMuted,
  parseHlsVolume,
} from "./hls-volume";

describe("parseHlsVolume", () => {
  it("reads a stored preference", () => {
    expect(parseHlsVolume('{"volume":0.4,"muted":true}')).toEqual({
      volume: 0.4,
      muted: true,
    });
  });

  it("falls back to full volume for nothing stored", () => {
    expect(parseHlsVolume(null)).toEqual(DEFAULT_HLS_VOLUME);
  });

  it("survives corrupt or half-written entries", () => {
    for (const raw of ['{"volume"', "null", "7", '{"volume":"loud"}', "[]"]) {
      const pref = parseHlsVolume(raw);
      expect(pref.volume).toBeGreaterThanOrEqual(0);
      expect(pref.volume).toBeLessThanOrEqual(1);
      expect(typeof pref.muted).toBe("boolean");
    }
  });

  it("clamps a level from outside 0..1", () => {
    expect(parseHlsVolume('{"volume":4}').volume).toBe(1);
    expect(parseHlsVolume('{"volume":-2}').volume).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(1);
  });
});

describe("effectiveMuted", () => {
  const loud = { volume: 1, muted: false };

  it("is silent when the person asked for silence", () => {
    expect(
      effectiveMuted({ pref: { volume: 0.5, muted: true }, autoplayMuted: false }),
    ).toBe(true);
  });

  it("is silent when the browser refused sound, without touching the preference", () => {
    expect(effectiveMuted({ pref: loud, autoplayMuted: true })).toBe(true);
    // The preference itself is untouched: the refusal is the browser's, not a
    // choice, so clearing it must restore sound rather than leave it muted.
    expect(loud.muted).toBe(false);
    expect(effectiveMuted({ pref: loud, autoplayMuted: false })).toBe(false);
  });
});

describe("the slider and the mute button do not fight", () => {
  it("dragging to zero is a mute", () => {
    expect(applySliderChange(0)).toEqual({ volume: 0, muted: true });
  });

  it("dragging up off zero unmutes", () => {
    expect(applySliderChange(0.3)).toEqual({ volume: 0.3, muted: false });
  });

  it("muting then unmuting comes back to the level that was picked", () => {
    const picked = { volume: 0.4, muted: false };
    const muted = applyMuteToggle(picked, 1);
    expect(muted).toEqual({ volume: 0.4, muted: true });
    expect(applyMuteToggle(muted, 1)).toEqual({ volume: 0.4, muted: false });
  });

  it("unmuting from a zero level restores something audible", () => {
    expect(applyMuteToggle({ volume: 0, muted: true }, 0.6)).toEqual({
      volume: 0.6,
      muted: false,
    });
    // Nothing sensible remembered: full volume rather than silent-but-unmuted,
    // which would look like a broken button.
    expect(applyMuteToggle({ volume: 0, muted: true }, 0)).toEqual({
      volume: 1,
      muted: false,
    });
  });
});

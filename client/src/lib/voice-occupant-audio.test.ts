import { describe, expect, it } from "vitest";
import {
  voiceOccupantAudioAffordance,
  voiceOccupantAudioInMenu,
  voiceOccupantAudioSilenced,
} from "./voice-occupant-audio";

describe("voiceOccupantAudioAffordance", () => {
  it("shows nothing for a person with no audio at all", () => {
    // Yourself, or anyone in a call you have not joined: the panel would
    // govern nothing, so the row must not promise it.
    expect(voiceOccupantAudioAffordance({ menuOpen: false })).toBe("hidden");
  });

  it("stays hidden even with the menu flag set when there is no audio", () => {
    expect(voiceOccupantAudioAffordance({ menuOpen: true })).toBe("hidden");
  });

  it("shows on hover for somebody at full volume", () => {
    expect(voiceOccupantAudioAffordance({ voiceVolume: 1, menuOpen: false })).toBe(
      "hover",
    );
  });

  it("shows permanently for somebody turned down", () => {
    expect(
      voiceOccupantAudioAffordance({ voiceVolume: 0.4, menuOpen: false }),
    ).toBe("always");
  });

  it("shows permanently for somebody silenced", () => {
    expect(voiceOccupantAudioAffordance({ voiceVolume: 0, menuOpen: false })).toBe(
      "always",
    );
  });

  it("counts a turned-down share on its own", () => {
    expect(
      voiceOccupantAudioAffordance({
        voiceVolume: 1,
        shareVolume: 0.2,
        menuOpen: false,
      }),
    ).toBe("always");
  });

  it("shows permanently while its own panel is open", () => {
    expect(voiceOccupantAudioAffordance({ voiceVolume: 1, menuOpen: true })).toBe(
      "always",
    );
  });
});

describe("voiceOccupantAudioSilenced", () => {
  it("is false when there is no audio", () => {
    expect(voiceOccupantAudioSilenced({})).toBe(false);
  });

  it("is false at any audible volume", () => {
    expect(voiceOccupantAudioSilenced({ voiceVolume: 1 })).toBe(false);
    expect(voiceOccupantAudioSilenced({ voiceVolume: 0.1 })).toBe(false);
  });

  it("is true when the only track is at zero", () => {
    expect(voiceOccupantAudioSilenced({ voiceVolume: 0 })).toBe(true);
  });

  it("is false while one of two tracks can still be heard", () => {
    expect(
      voiceOccupantAudioSilenced({ voiceVolume: 0, shareVolume: 0.8 }),
    ).toBe(false);
  });

  it("is true when both tracks are at zero", () => {
    expect(voiceOccupantAudioSilenced({ voiceVolume: 0, shareVolume: 0 })).toBe(
      true,
    );
  });
});

describe("voiceOccupantAudioInMenu", () => {
  it("puts the item in the right-click menu whenever the glyph shows", () => {
    expect(voiceOccupantAudioInMenu("hover")).toBe(true);
    expect(voiceOccupantAudioInMenu("always")).toBe(true);
  });

  it("keeps it out when there is no audio to govern", () => {
    // Yourself, and anyone in a call you have not joined. The moderation items
    // are unaffected either way.
    expect(voiceOccupantAudioInMenu("hidden")).toBe(false);
  });
});

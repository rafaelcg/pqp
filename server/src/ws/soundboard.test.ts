import { describe, expect, it } from "vitest";
import {
  offerSoundboardPlay,
  resetSoundboardPlays,
  soundboardPlayAllowed,
} from "./soundboard.js";

describe("soundboard play gate", () => {
  it("needs the bit, a matching room, and no moderator mute", () => {
    expect(
      soundboardPlayAllowed({
        canUseSoundboard: true,
        serverMuted: false,
        channelMatches: true,
      }),
    ).toBe(true);
    expect(
      soundboardPlayAllowed({
        canUseSoundboard: false,
        serverMuted: false,
        channelMatches: true,
      }),
    ).toBe(false);
    expect(
      soundboardPlayAllowed({
        canUseSoundboard: true,
        serverMuted: true,
        channelMatches: true,
      }),
    ).toBe(false);
    expect(
      soundboardPlayAllowed({
        canUseSoundboard: true,
        serverMuted: false,
        channelMatches: false,
      }),
    ).toBe(false);
  });

  it("lets one person overlap clips until the room is full", () => {
    resetSoundboardPlays();
    const now = 1_000;
    expect(
      offerSoundboardPlay({
        channelId: "room",
        userId: "a",
        durationMs: 500,
        now,
      }),
    ).toBe(true);
    expect(
      offerSoundboardPlay({
        channelId: "room",
        userId: "a",
        durationMs: 500,
        now: now + 10,
      }),
    ).toBe(true);
    for (let i = 0; i < 10; i += 1) {
      expect(
        offerSoundboardPlay({
          channelId: "room",
          userId: "b",
          durationMs: 500,
          now,
        }),
      ).toBe(true);
    }
    expect(
      offerSoundboardPlay({
        channelId: "room",
        userId: "c",
        durationMs: 500,
        now,
      }),
    ).toBe(false);
    expect(
      offerSoundboardPlay({
        channelId: "room",
        userId: "c",
        durationMs: 500,
        now: now + 500,
      }),
    ).toBe(true);
  });
});

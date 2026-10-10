import { describe, expect, it } from "vitest";
import {
  noteRemoteSoundboardPlay,
  offerSoundboardPlay,
  SOUNDBOARD_USER_CONCURRENCY,
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
          userId: `b${i}`,
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

  it("stops one person from holding every slot", () => {
    resetSoundboardPlays();
    const now = 1_000;
    for (let i = 0; i < SOUNDBOARD_USER_CONCURRENCY; i += 1) {
      expect(
        offerSoundboardPlay({ channelId: "room", userId: "a", durationMs: 5000, now }),
      ).toBe(true);
    }
    expect(
      offerSoundboardPlay({ channelId: "room", userId: "a", durationMs: 5000, now }),
    ).toBe(false);
    // Somebody else still gets in, and the first person gets a slot back when
    // a clip ends.
    expect(
      offerSoundboardPlay({ channelId: "room", userId: "b", durationMs: 5000, now }),
    ).toBe(true);
    expect(
      offerSoundboardPlay({
        channelId: "room",
        userId: "a",
        durationMs: 5000,
        now: now + 6000,
      }),
    ).toBe(true);
  });

  it("counts a play the other machine admitted toward the room cap", () => {
    resetSoundboardPlays();
    const now = 1_000;
    for (let i = 0; i < 12; i += 1) {
      noteRemoteSoundboardPlay({ channelId: "room", userId: `r${i}`, now });
    }
    expect(
      offerSoundboardPlay({ channelId: "room", userId: "a", durationMs: 500, now }),
    ).toBe(false);
  });

  it("frees a remote slot when the admitted clip ends, not at the maximum", () => {
    resetSoundboardPlays();
    const now = 1_000;
    for (let i = 0; i < 12; i += 1) {
      noteRemoteSoundboardPlay({
        channelId: "room",
        userId: `r${i}`,
        durationMs: 500,
        now,
      });
    }
    expect(
      offerSoundboardPlay({ channelId: "room", userId: "a", durationMs: 500, now }),
    ).toBe(false);
    expect(
      offerSoundboardPlay({
        channelId: "room",
        userId: "a",
        durationMs: 500,
        now: now + 600,
      }),
    ).toBe(true);
  });
});

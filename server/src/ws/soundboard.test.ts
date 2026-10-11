import { describe, expect, it } from "vitest";
import {
  noteRemoteSoundboardPlay,
  offerSoundboardPlay,
  SOUNDBOARD_USER_CONCURRENCY,
  resetSoundboardPlays,
  soundboardPlayAllowed,
} from "./soundboard.js";

describe("soundboard play gate", () => {
  it("needs the flag, the bit, an open mic, a matching room, and no moderator mute", () => {
    const open = {
      enabled: true,
      deafened: false,
      canUseSoundboard: true,
      canSpeak: true,
      serverMuted: false,
      channelMatches: true,
    };
    expect(soundboardPlayAllowed(open)).toBe(true);
    expect(soundboardPlayAllowed({ ...open, enabled: false })).toBe(false);
    // Deafened: you would play what you cannot hear. Discord refuses it too.
    expect(soundboardPlayAllowed({ ...open, deafened: true })).toBe(false);
    expect(soundboardPlayAllowed({ ...open, canUseSoundboard: false })).toBe(false);
    expect(soundboardPlayAllowed({ ...open, serverMuted: true })).toBe(false);
    expect(soundboardPlayAllowed({ ...open, channelMatches: false })).toBe(false);
  });

  it("refuses an audience seat whose mic is locked, whatever the bit says", () => {
    // A closed watch party floor denies SPEAK to @everyone and leaves
    // USE_SOUNDBOARD alone; audience mode takes canSpeak and nothing else.
    expect(
      soundboardPlayAllowed({
        enabled: true,
        deafened: false,
        canUseSoundboard: true,
        canSpeak: false,
        serverMuted: false,
        channelMatches: true,
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

describe("soundboard play budget", () => {
  it("allows a burst of five, then one every two seconds", async () => {
    const { resetSoundboardPlays, SOUNDBOARD_PLAY_REFILL_MS } = await import("./soundboard.js");
    resetSoundboardPlays();
    const offer = (now: number, channelId = `room-${now}`) =>
      offerSoundboardPlay({ channelId, userId: "spammer", durationMs: 10, now });
    // Each in its own room so the overlap caps never bind: only the budget.
    const burst = [0, 1, 2, 3, 4].map((i) => offer(1_000 + i));
    expect(burst).toEqual([true, true, true, true, true]);
    expect(offer(1_010)).toBe(false);
    expect(offer(1_004 + SOUNDBOARD_PLAY_REFILL_MS)).toBe(true);
    expect(offer(1_005 + SOUNDBOARD_PLAY_REFILL_MS)).toBe(false);
  });

  it("spends the budget for plays the other machine admitted", async () => {
    const { noteRemoteSoundboardPlay, resetSoundboardPlays } = await import("./soundboard.js");
    resetSoundboardPlays();
    for (let i = 0; i < 5; i += 1) {
      noteRemoteSoundboardPlay({ channelId: `elsewhere-${i}`, userId: "hopper", durationMs: 10, now: 5_000 });
    }
    expect(
      offerSoundboardPlay({ channelId: "here", userId: "hopper", durationMs: 10, now: 5_001 }),
    ).toBe(false);
  });
});

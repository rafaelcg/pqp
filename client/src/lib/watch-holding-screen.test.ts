import { describe, expect, it } from "vitest";
import { resolveHoldingScreenReason } from "./watch-holding-screen";

/**
 * C3, `docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`: "bolhas" x30 —
 * nobody could tell a network drop from a dead egress from their own token
 * going stale for a second. This pins the mapping from `phase` and the stall
 * watchdog's `lastReason` to what the holding screen says, independent of
 * any `<video>` or hls.js.
 */
describe("resolveHoldingScreenReason", () => {
  const playing = {
    phase: "playing" as const,
    hasFrame: true,
    stallReason: null,
    authGraceActive: false,
  };

  it("says nothing while a frame is actually playing", () => {
    expect(resolveHoldingScreenReason(playing)).toBeNull();
  });

  it("still has something to say if the phase is playing but no frame has arrived", () => {
    expect(
      resolveHoldingScreenReason({ ...playing, hasFrame: false }),
    ).toBe("reconnecting");
  });

  it("maps a dead egress restart to restarting, with a countdown available", () => {
    expect(
      resolveHoldingScreenReason({
        ...playing,
        hasFrame: false,
        stallReason: "sequence-stuck",
      }),
    ).toBe("restarting");
  });

  it("maps a playlist-gone 404 to restarting — same dead-window copy", () => {
    expect(
      resolveHoldingScreenReason({
        ...playing,
        hasFrame: true,
        stallReason: "playlist-gone",
      }),
    ).toBe("restarting");
  });

  it("shows restarting even with a frame still on screen and phase still playing (B1.3: no rebuild for sequence-stuck)", () => {
    // The player no longer tears hls.js down for a stuck egress, so `phase`
    // never leaves "playing" and the last frame never leaves `hasFrame`.
    // `stallReason` has to carry this on its own.
    expect(
      resolveHoldingScreenReason({
        ...playing,
        stallReason: "sequence-stuck",
      }),
    ).toBe("restarting");
  });

  it("maps every other stall reason to the generic reconnecting copy", () => {
    for (const stallReason of ["fatal", "stall", null] as const) {
      expect(
        resolveHoldingScreenReason({
          ...playing,
          hasFrame: false,
          stallReason,
        }),
        `stallReason=${stallReason}`,
      ).toBe("reconnecting");
    }
  });

  it("stays silent about a fresh auth failure rather than flashing a stall overlay", () => {
    expect(
      resolveHoldingScreenReason({
        ...playing,
        hasFrame: false,
        stallReason: "fatal",
        authGraceActive: true,
      }),
    ).toBe("silent");
  });

  it("prefers dead over a lingering auth grace: the watchdog gave up for real", () => {
    expect(
      resolveHoldingScreenReason({
        phase: "dead",
        hasFrame: false,
        stallReason: "fatal",
        authGraceActive: true,
      }),
    ).toBe("dead");
  });

  it("the dead phase always wins, whatever the watchdog's reason says", () => {
    expect(
      resolveHoldingScreenReason({
        phase: "dead",
        hasFrame: false,
        stallReason: "sequence-stuck",
        authGraceActive: false,
      }),
    ).toBe("dead");
  });
});

/**
 * A replay's playlist is a fixed, ended media sequence: it is SUPPOSED to
 * stop advancing once fully buffered, which live's `sequence-stuck` reads as
 * a dead egress. `mode: "vod"` gets a whole different vocabulary rather than
 * the live one with different labels -- see the file header.
 */
describe("resolveHoldingScreenReason (mode: vod)", () => {
  const buffering = {
    phase: "playing" as const,
    hasFrame: false,
    stallReason: null,
    authGraceActive: false,
    mode: "vod" as const,
  };

  it("says nothing while a frame is actually playing", () => {
    expect(
      resolveHoldingScreenReason({ ...buffering, hasFrame: true }),
    ).toBeNull();
  });

  it("is plain buffering before the first frame, never the live restart copy", () => {
    expect(resolveHoldingScreenReason(buffering)).toBe("buffering");
  });

  it("never reads sequence-stuck as a dead egress: a VOD playlist's sequence never moves", () => {
    expect(
      resolveHoldingScreenReason({ ...buffering, stallReason: "sequence-stuck" }),
    ).toBe("buffering");
  });

  it("never reads playlist-gone as a live restart either", () => {
    expect(
      resolveHoldingScreenReason({ ...buffering, stallReason: "playlist-gone" }),
    ).toBe("buffering");
  });

  it("every other stall reason is still plain buffering, not the live 'stalled, reconnecting' copy", () => {
    for (const stallReason of ["fatal", "stall", null] as const) {
      expect(
        resolveHoldingScreenReason({ ...buffering, stallReason }),
        `stallReason=${stallReason}`,
      ).toBe("buffering");
    }
  });

  it("stays silent about a fresh auth failure, same as live", () => {
    expect(
      resolveHoldingScreenReason({ ...buffering, authGraceActive: true }),
    ).toBe("silent");
  });

  it("the watchdog giving up is 'unavailable' -- the recording is gone, not 'the stream died'", () => {
    expect(
      resolveHoldingScreenReason({ ...buffering, phase: "dead" }),
    ).toBe("unavailable");
  });
});

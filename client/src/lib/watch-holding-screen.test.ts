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

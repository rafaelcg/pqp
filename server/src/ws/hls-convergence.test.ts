import { afterEach, describe, expect, it } from "vitest";
import {
  resetConvergenceTurns,
  rotateConvergenceTurnsForTests,
  takeConvergenceTurn,
} from "./voice.js";

/**
 * WHOSE TURN IT IS to ask `hls_sessions` whether a quiet, watched channel is
 * in fact live on the other machine.
 *
 * The keyframe clock is per channel and the timers fire in whatever order
 * they were started, so "the first eight to ask each tick" is not a fair rule:
 * the same channels would ask every time and the ones behind them would never
 * recover from a lost bus frame at all, which is the one thing this path
 * exists for. The rotation is what makes the budget flat AND fair, and a
 * channel that is not up gets NO frame rather than a `stream: null` one more
 * chance for a client to read silence as an end.
 */
describe("the HLS convergence rotation", () => {
  afterEach(() => {
    resetConvergenceTurns();
  });

  it("registers a channel on its first ask and gives it a turn on a later rotation", () => {
    // Never on the first ask: a wave of channels appearing at once must not
    // become a wave of queries.
    expect(takeConvergenceTurn("a")).toBe(false);
    expect(rotateConvergenceTurnsForTests()).toEqual(["a"]);
    expect(takeConvergenceTurn("a")).toBe(true);
    // One read per turn, however many watchers ask.
    expect(takeConvergenceTurn("a")).toBe(false);
  });

  it("over budget: no turn, and the channels behind still get theirs", () => {
    // Ten channels, a budget of eight.
    const channels = Array.from({ length: 10 }, (_, i) => `c${i}`);
    for (const channel of channels) {
      takeConvergenceTurn(channel);
    }

    const first = rotateConvergenceTurnsForTests();
    expect(first).toHaveLength(8);
    const granted = channels.filter((c) => takeConvergenceTurn(c));
    expect(granted).toEqual(first);
    // The two that were over budget were refused, which is what the keyframe
    // reads as "say nothing at all this tick".
    expect(granted).toHaveLength(8);

    // AND THE CURSOR SURVIVES THE TICK: the next rotation starts where this
    // one stopped, so the two that missed out are first in line rather than
    // starved behind the same eight forever.
    const second = rotateConvergenceTurnsForTests();
    expect(second.slice(0, 2)).toEqual(channels.slice(8));
    expect(channels.slice(8).every((c) => takeConvergenceTurn(c))).toBe(true);
  });

  it("every channel comes up within a bounded number of rotations", () => {
    const channels = Array.from({ length: 20 }, (_, i) => `d${i}`);
    for (const channel of channels) {
      takeConvergenceTurn(channel);
    }
    const seen = new Set<string>();
    // 20 channels, 8 a tick: three rotations is enough for all of them.
    for (let tick = 0; tick < 3; tick += 1) {
      for (const channel of rotateConvergenceTurnsForTests()) {
        seen.add(channel);
      }
    }
    expect(seen.size).toBe(channels.length);
  });
});

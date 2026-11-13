import { describe, expect, it } from "vitest";
import { bandEnvelope, clipBars, clipReach, clipSpan, clipWindow, levelOfGain, msPerPixel, toFraction, volumeDelta } from "./jam-clip";
import { NUDGE_LIMIT_MS } from "./jam-take-edit";

// A take as the engine hands it back: the count-in (2.4 s) and a 30 ms round
// trip sit before song time 0, hidden by the trim.
const source = { baseOffsetMs: -2430, durationMs: 10_000, minTrimStartMs: 2430 };
const asRecorded = { trimStartMs: 2430, trimEndMs: 0, nudgeMs: 0, gain: 1 };

describe("where the take sits", () => {
  it("the audible stretch starts at song time 0 as recorded", () => {
    expect(clipSpan(source, asRecorded)).toEqual({ startMs: 0, endMs: 7570 });
  });

  it("a nudge moves the whole take, the cuts move its ends", () => {
    expect(clipSpan(source, { ...asRecorded, nudgeMs: 20 })).toEqual({ startMs: 20, endMs: 7590 });
    expect(clipSpan(source, { ...asRecorded, trimStartMs: 3430, trimEndMs: 500 })).toEqual({ startMs: 1000, endMs: 7070 });
  });

  it("the reach never shows the hidden head", () => {
    expect(clipReach(source, 0)).toEqual({ startMs: 0, endMs: 7570 });
  });
});

describe("the window the editor draws", () => {
  it("whole: the take at any nudge, with room either side, and it does not move with the edits", () => {
    const whole = clipWindow(source, asRecorded, "whole");
    expect(whole.startMs).toBeLessThan(-NUDGE_LIMIT_MS);
    expect(whole.endMs).toBeGreaterThan(7570 + NUDGE_LIMIT_MS);
    expect(clipWindow(source, { ...asRecorded, nudgeMs: 300, trimEndMs: 2000 }, "whole")).toEqual(whole);
  });

  it("close: three seconds around where the take starts", () => {
    expect(clipWindow(source, { ...asRecorded, nudgeMs: 40 }, "close")).toEqual({ startMs: -960, endMs: 2040 });
  });

  it("fractions and pixels", () => {
    const window = { startMs: -1000, endMs: 3000 };
    expect(toFraction(window, 0)).toBe(0.25);
    expect(toFraction(window, -5000)).toBe(0);
    expect(toFraction(window, 9000)).toBe(1);
    expect(msPerPixel(window, 400)).toBe(10);
  });
});

describe("the band behind the take", () => {
  it("is silent where nobody plays and loud where somebody does", () => {
    const lane = { peaks: [1, 1, 1, 1], offsetMs: 2000, trimStartMs: 0, trimEndMs: 0, durationMs: 4000 };
    const out = bandEnvelope([lane], { startMs: 0, endMs: 8000 }, 8);
    expect(out).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
  });

  it("each lane is scaled to its own loudest moment, so a quiet bass still shows", () => {
    const loud = { peaks: [1, 1], offsetMs: 0, trimStartMs: 0, trimEndMs: 0, durationMs: 2000 };
    const quiet = { peaks: [0.1, 0.1], offsetMs: 2000, trimStartMs: 0, trimEndMs: 0, durationMs: 2000 };
    expect(bandEnvelope([loud, quiet], { startMs: 0, endMs: 4000 }, 4)).toEqual([1, 1, 1, 1]);
  });

  it("a trimmed part is not drawn", () => {
    const lane = { peaks: [1, 1, 1, 1], offsetMs: 0, trimStartMs: 2000, trimEndMs: 0, durationMs: 4000 };
    expect(bandEnvelope([lane], { startMs: 0, endMs: 4000 }, 4)).toEqual([0, 0, 1, 1]);
  });

  it("no lanes, no width: nothing", () => {
    expect(bandEnvelope([], { startMs: 0, endMs: 1000 }, 3)).toEqual([0, 0, 0]);
    expect(bandEnvelope([], { startMs: 0, endMs: 1000 }, 0)).toEqual([]);
  });
});

describe("what a take's volume looks like", () => {
  it("a take as recorded is full height and a quieter one is shorter, never flat", () => {
    expect(levelOfGain(1)).toBe(1);
    expect(levelOfGain(0.25)).toBeCloseTo(0.475, 5);
    expect(levelOfGain(0)).toBe(0.3);
    expect(levelOfGain(2)).toBe(1.12);
  });

  it("a number that is not a volume reads as the recorded level", () => {
    expect(levelOfGain(Number.NaN)).toBe(1);
    expect(levelOfGain(-3)).toBe(0.3);
  });

  it("is said as a signed percent, and not at all at the recorded level", () => {
    expect(volumeDelta(1)).toBeNull();
    expect(volumeDelta(0.25)).toBe("-75%");
    expect(volumeDelta(1.2)).toBe("+20%");
    expect(volumeDelta(1.004)).toBeNull();
  });
});

describe("the take's own bars", () => {
  it("start after the hidden head and reach the top", () => {
    const peaks = [0.9, 0.9, 0.1, 0.2, 0.4, 0.2];
    const bars = clipBars(peaks, { baseOffsetMs: -2000, durationMs: 6000, minTrimStartMs: 2000 }, 4);
    expect(bars).toHaveLength(4);
    expect(Math.max(...bars)).toBe(1);
    // the loud count-in head is not drawn
    expect(bars[0]).toBeLessThan(1);
  });
});

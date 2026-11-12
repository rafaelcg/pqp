import { describe, expect, it } from "vitest";
import { audibleAt, laneBars, levelBars, levelScale, peakAt, windowBars } from "./levels";

const track = {
  offsetMs: 1000,
  trimStartMs: 500,
  trimEndMs: 500,
  durationMs: 4000,
  // 8 slices of 500 ms over the whole buffer
  peaks: [0.1, 0.2, 0.4, 0.8, 0.8, 0.4, 0.2, 0.1],
};

describe("peakAt", () => {
  it("reads the slice under a song time by the buffer's own clock", () => {
    // song 1000 is buffer 0 (trimmed); 2000 is buffer 1000 = slice 2
    expect(peakAt(track, 2000)).toBe(0.4);
    expect(peakAt(track, 3000)).toBe(0.8);
  });

  it("is silent outside the audible span, trims included", () => {
    expect(peakAt(track, 500)).toBe(0);
    expect(peakAt(track, 1200)).toBe(0); // inside the trimmed head
    expect(peakAt(track, 4800)).toBe(0); // inside the trimmed tail
    expect(audibleAt(track, 1500)).toBe(true);
    expect(audibleAt(track, 4500)).toBe(false);
  });

  it("is silent for a track with nothing to read", () => {
    expect(peakAt({ ...track, peaks: [] }, 2000)).toBe(0);
    expect(peakAt({ ...track, durationMs: 0 }, 2000)).toBe(0);
  });
});

describe("levelBars", () => {
  it("ends on the present and reads backwards", () => {
    const bars = levelBars(track, 3000, 3, 500, 1);
    expect(bars).toHaveLength(3);
    expect(bars[2]).toBe(0.8);
    expect(bars[0]).toBe(0.4); // 2000 ms: slice 2
  });

  it("scales and never passes full", () => {
    expect(levelBars(track, 3000, 1, 500, 4)[0]).toBe(1);
  });
});

describe("levelScale", () => {
  it("makes the loudest peak read as full, and leaves silence alone", () => {
    expect(levelScale([0.1, 0.5])).toBeCloseTo(2);
    expect(levelScale([0, 0.01])).toBe(1);
    expect(levelScale([])).toBe(1);
  });
});

describe("windowBars", () => {
  it("centres on the song time and goes quiet where the part is not playing", () => {
    const bars = windowBars(track, 3000, 5, 1);
    expect(bars).toHaveLength(5);
    expect(bars[2]).toBe(0.8);
    expect(windowBars(track, 100, 5, 1).every((value) => value === 0)).toBe(true);
  });
});

describe("laneBars", () => {
  it("lays the track on the song: flat before it comes in, flat after it ends", () => {
    const bars = laneBars(track, 6000, 12);
    expect(bars).toHaveLength(12);
    expect(bars[0]).toBe(0);
    expect(bars[1]).toBe(0);
    expect(Math.max(...bars)).toBe(1);
    expect(bars[11]).toBe(0);
  });

  it("is empty for a song with no length", () => {
    expect(laneBars(track, 0, 12)).toEqual([]);
  });
});

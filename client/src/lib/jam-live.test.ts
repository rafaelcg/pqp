import { describe, expect, it } from "vitest";
import { liveBars, liveTimelineEndMs } from "./jam-live";

describe("the waveform that grows while recording", () => {
  it("has no bars before anything is heard", () => {
    expect(liveBars([], 200)).toEqual([]);
    expect(liveBars([0.5], 0)).toEqual([]);
  });

  it("takes the loudest peak in each slot", () => {
    // 80 ms per peak, 160 ms per slot: peaks 0,1 | 2,3 | 4
    const bars = liveBars([0.04, 0.16, 0.25, 0.01, 0.36], 160);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toBeCloseTo(Math.sqrt(0.16));
    expect(bars[1]).toBeCloseTo(Math.sqrt(0.25));
    expect(bars[2]).toBeCloseTo(Math.sqrt(0.36));
  });

  it("never redraws a finished bar when more audio arrives", () => {
    const first = liveBars([0.1, 0.2, 0.3, 0.4], 160);
    const later = liveBars([0.1, 0.2, 0.3, 0.4, 0.9, 0.9], 160);
    expect(later.slice(0, first.length)).toEqual(first);
  });

  it("keeps every bar within 0..1", () => {
    expect(Math.max(...liveBars([2, 3], 160))).toBe(1);
  });
});

describe("the timeline while recording", () => {
  it("is at least eight seconds, in steps of five", () => {
    expect(liveTimelineEndMs(0, 0)).toBe(10000);
    expect(liveTimelineEndMs(0, 5000)).toBe(10000);
  });

  it("holds the song's own length and rounds it up", () => {
    expect(liveTimelineEndMs(62000, 1000)).toBe(65000);
  });

  it("makes room once the take runs past the song", () => {
    expect(liveTimelineEndMs(30000, 29000)).toBe(35000);
    expect(liveTimelineEndMs(30000, 40000)).toBe(45000);
  });

  it("does not move between two ticks of the same step", () => {
    expect(liveTimelineEndMs(0, 6000)).toBe(liveTimelineEndMs(0, 6040));
  });
});

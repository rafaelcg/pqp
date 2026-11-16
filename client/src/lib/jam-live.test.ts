import { describe, expect, it } from "vitest";
import { createLiveBars, LIVE_PEAK_MS, liveTimelineEndMs } from "./jam-live";

/** The plain full scan, as the reference the incremental fold must equal. Not shipped. */
function liveBars(peaks: readonly number[], slotMs: number, pitchMs = LIVE_PEAK_MS): number[] {
  if (!(slotMs > 0) || peaks.length === 0) {
    return [];
  }
  const count = Math.ceil((peaks.length * pitchMs) / slotMs);
  const bars = new Array<number>(count).fill(0);
  for (let i = 0; i < peaks.length; i++) {
    const slot = Math.min(count - 1, Math.floor((i * pitchMs) / slotMs));
    bars[slot] = Math.max(bars[slot] ?? 0, peaks[i] ?? 0);
  }
  return bars.map((value) => Math.min(1, Math.sqrt(value)));
}

describe("the same bars, folded in as the take grows", () => {
  it("equals the full scan at every step of a growing take", () => {
    const fold = createLiveBars();
    const peaks: number[] = [];
    for (let i = 0; i < 400; i++) {
      peaks.push(Math.abs(Math.sin(i / 7)) * Math.min(1, i / 100));
      expect(fold(peaks, 240)).toEqual(liveBars(peaks, 240));
    }
  });

  it("rebuilds when the slot width changes and when a new take starts", () => {
    const fold = createLiveBars();
    const first = [0.2, 0.4, 0.9, 0.1, 0.3];
    expect(fold(first, 160)).toEqual(liveBars(first, 160));
    expect(fold(first, 400)).toEqual(liveBars(first, 400));
    const second = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    expect(fold(second, 400)).toEqual(liveBars(second, 400));
  });

  it("does only the new peaks' work per update", () => {
    const fold = createLiveBars();
    const peaks: number[] = [];
    let reads = 0;
    const counted = new Proxy(peaks, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    for (let i = 0; i < 200; i++) {
      peaks.push(0.5);
      fold(counted, 240);
    }
    // one element read per update after the first folds (not k per update)
    expect(reads).toBeLessThan(400);
  });
});

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

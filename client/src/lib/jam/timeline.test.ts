import { describe, expect, it } from "vitest";
import {
  audibleSpan,
  clampSeek,
  effectiveGains,
  planSegment,
  positionAt,
  segmentAt,
  songDurationMs,
  type StemTiming,
} from "./timeline";

const t = (over: Partial<StemTiming>): StemTiming => ({
  offsetMs: 0,
  trimStartMs: 0,
  trimEndMs: 0,
  durationMs: 10_000,
  ...over,
});

describe("timeline: placement", () => {
  it("audible span honours offset and both trims; an over-trimmed stem is silent", () => {
    expect(audibleSpan(t({ offsetMs: 500, trimStartMs: 200, trimEndMs: 300 }))).toEqual({
      songStartMs: 700,
      songEndMs: 10_200,
    });
    expect(audibleSpan(t({ trimStartMs: 6000, trimEndMs: 4000 }))).toBeNull();
  });

  it("the song ends at the last audible end and never before 0", () => {
    expect(songDurationMs([t({ offsetMs: -2000 }), t({ offsetMs: 1000, trimEndMs: 500 })])).toBe(10_500);
    expect(songDurationMs([t({ offsetMs: -20_000 })])).toBe(0);
  });

  it("a negative offset plays from inside the buffer at song 0", () => {
    const [e] = planSegment([{ id: "a", timing: t({ offsetMs: -1500 }) }], 0, 20_000, 48000);
    expect(e).toEqual({ id: "a", startFrame: 0, bufferOffsetFrames: 72_000, durationFrames: 408_000 });
  });

  it("a later stem waits, trims start inside the buffer, and the segment end cuts it", () => {
    const plan = planSegment(
      [
        { id: "late", timing: t({ offsetMs: 2000, trimStartMs: 250 }) },
        { id: "short", timing: t({ durationMs: 1000 }) },
      ],
      1000,
      5000,
      48000,
    );
    expect(plan).toEqual([
      // audible from song 2250 = 1250 ms after 1000; buffer from 250 ms; until song 5000
      { id: "late", startFrame: 60_000, bufferOffsetFrames: 12_000, durationFrames: 132_000 },
    ]);
  });

  it("keeps the invariant: buffer sample j of every stem sounds at round((offset - from)*sr) + j", () => {
    const sr = 44100;
    const stems = [
      { id: "a", timing: t({ offsetMs: 13.7, trimStartMs: 3.3 }) },
      { id: "b", timing: t({ offsetMs: -987.25, trimEndMs: 11 }) },
      { id: "c", timing: t({ offsetMs: 4321.01, trimStartMs: 1000.5 }) },
    ];
    for (const from of [0, 0.4, 500.33, 4000]) {
      for (const e of planSegment(stems, from, 9000, sr)) {
        const s = stems.find((x) => x.id === e.id)!.timing;
        const d = Math.round(((s.offsetMs - from) * sr) / 1000);
        expect(e.startFrame - e.bufferOffsetFrames).toBe(d);
        expect(e.startFrame).toBeGreaterThanOrEqual(0);
        expect(e.bufferOffsetFrames).toBeGreaterThanOrEqual(Math.round((s.trimStartMs * sr) / 1000));
      }
    }
  });

  it("two stems with whole-ms offsets at 48 kHz land a whole number of frames apart", () => {
    const plan = planSegment(
      [
        { id: "a", timing: t({ offsetMs: 0 }) },
        { id: "b", timing: t({ offsetMs: 37 }) },
      ],
      0,
      5000,
      48000,
    );
    expect(plan[1].startFrame - plan[0].startFrame).toBe(37 * 48);
  });
});

describe("timeline: mix", () => {
  it("mute wins, solo isolates, and a muted solo does not silence the rest", () => {
    const g = effectiveGains([
      { id: "a", mix: { gain: 0.8, muted: false, solo: true } },
      { id: "b", mix: { gain: 1, muted: false, solo: false } },
      { id: "c", mix: { gain: 1, muted: true, solo: true } },
    ]);
    expect([...g.entries()]).toEqual([
      ["a", 0.8],
      ["b", 0],
      ["c", 0],
    ]);
    const g2 = effectiveGains([
      { id: "a", mix: { gain: 1, muted: true, solo: true } },
      { id: "b", mix: { gain: 0.5, muted: false, solo: false } },
    ]);
    expect(g2.get("b")).toBe(0.5);
  });
});

describe("timeline: transport and loop", () => {
  const anchor = { songStartMs: 1000, ctxStart: 10, loop: { startMs: 2000, endMs: 4000 } };

  it("position runs from the start, wraps in the loop, and reads below the start before it", () => {
    expect(positionAt(anchor, 10)).toBe(1000);
    expect(positionAt(anchor, 11.5)).toBe(2500);
    expect(positionAt(anchor, 13)).toBeCloseTo(2000); // reached loop end, wrapped
    expect(positionAt(anchor, 14.25)).toBeCloseTo(3250);
    expect(positionAt(anchor, 9)).toBe(0);
  });

  it("a loop that ends before the start point is ignored", () => {
    expect(positionAt({ ...anchor, songStartMs: 5000 }, 12)).toBe(7000);
    expect(segmentAt({ ...anchor, songStartMs: 5000 }, 1, 9000, 48000)).toBeNull();
  });

  it("loop passes are back to back in whole frames, without drift over many passes", () => {
    const sr = 44100;
    const a = { songStartMs: 0, ctxStart: 0, loop: { startMs: 1000.3, endMs: 2333.37 } };
    const s0 = segmentAt(a, 0, 9000, sr)!;
    const s1 = segmentAt(a, 1, 9000, sr)!;
    const s100 = segmentAt(a, 100, 9000, sr)!;
    expect(s0).toEqual({ fromMs: 0, toMs: 2333.37, startFrames: 0 });
    const first = Math.round((2333.37 * sr) / 1000);
    const len = Math.round(((2333.37 - 1000.3) * sr) / 1000);
    expect(s1.startFrames).toBe(first);
    expect(s100.startFrames).toBe(first + 99 * len);
  });

  it("seek clamps to the song", () => {
    expect(clampSeek(-5, 1000)).toBe(0);
    expect(clampSeek(5000, 1000)).toBe(1000);
    expect(clampSeek(Number.NaN, 1000)).toBe(0);
  });
});

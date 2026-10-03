import { describe, expect, it } from "vitest";
import {
  DEFAULT_PICTURE_THRESHOLDS,
  judgePicture,
  lumaDiff,
  lumaFromRgba,
  lumaStats,
  type PictureSample,
} from "./share-picture-check";

/**
 * Synthetic frames, at the grid size the watch reads (32x18 luma cells). Each
 * fixture is a picture somebody really shares, written down as numbers, so the
 * line between "dead" and "dark or still" is a test and not a hunch.
 */
const W = 32;
const H = 18;
const PACE_MS = 2_000;

/** Deterministic noise, so a failing case fails the same way every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function grid(fn: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
    }
  }
  return out;
}

/** A capture that came back as zeros: what a surface the system will not compose for the capturer gives. */
const blackCapture = () => grid(() => 0);

/** The same, with the pointer drawn into it (Chromium composites the cursor onto the frame). */
const blackCaptureWithCursor = () => grid((x, y) => (x === 15 && y === 9 ? 60 : 0));

/**
 * A dark film scene: a night street. Mostly 6 to 20, a lit window and a
 * street lamp near 90 to 140 over about 4 % of the frame, grain that moves
 * each sample, and a slow pan.
 */
function darkFilm(step: number, seed = 7): Uint8Array {
  const noise = rng(seed + step * 31);
  return grid((x, y) => {
    const base = 6 + (y / H) * 12;
    const lamp = (x + step) % W >= 24 && (x + step) % W <= 25 && y >= 3 && y <= 6 ? 110 : 0;
    const window = x >= 4 && x <= 6 && y >= 8 && y <= 9 ? 90 : 0;
    return base + lamp + window + (noise() - 0.5) * 6;
  });
}

/** Darker still: the scene right before a cut, mean around 3, a candle in one corner. */
function nearBlackFilm(step: number): Uint8Array {
  const noise = rng(99 + step * 17);
  return grid((x, y) => {
    const candle = x >= 28 && y >= 14 ? 70 : 0;
    return 1.5 + candle + noise() * 3;
  });
}

/** A slide: white page, dark text lines. Pixel-identical every sample. */
const slide = () => grid((x, y) => (y % 3 === 1 && x > 2 && x < 28 ? 30 : 235));

/** A game in motion: textured, and different every sample. */
function gameFrame(step: number): Uint8Array {
  const noise = rng(1234 + step);
  return grid((x, y) => 60 + ((x * 7 + y * 13 + step * 29) % 120) + noise() * 20);
}

/**
 * Build a run of samples at the watch's pace. `framesPerSample` is how many
 * frames the capturer handed over between two samples (0 means none arrived:
 * the grid is null, exactly what the watch records).
 */
function run(
  count: number,
  picture: (i: number) => Uint8Array,
  framesPerSample: (i: number) => number = () => 60,
  muted: (i: number) => boolean = () => false,
): PictureSample[] {
  const out: PictureSample[] = [];
  let frames = 0;
  for (let i = 0; i < count; i += 1) {
    const delivered = framesPerSample(i);
    frames += delivered;
    out.push({
      at: i * PACE_MS,
      frames,
      luma: delivered > 0 ? picture(i) : null,
      muted: muted(i),
    });
  }
  return out;
}

describe("lumaStats / lumaDiff / lumaFromRgba", () => {
  it("measures mean and the 98th percentile", () => {
    const g = grid((x) => (x === 0 ? 255 : 0));
    const stats = lumaStats(g);
    expect(stats.mean).toBeCloseTo(255 / W, 5);
    // 18 of 576 cells are bright (3 %), so the 98th percentile is bright...
    expect(stats.p98).toBe(255);
    // ...and a single bright cell (the cursor) is not.
    expect(lumaStats(blackCaptureWithCursor()).p98).toBe(0);
  });

  it("diffs grids of the same size and refuses others", () => {
    expect(lumaDiff(blackCapture(), blackCapture())).toBe(0);
    expect(lumaDiff(grid(() => 10), grid(() => 12))).toBe(2);
    expect(lumaDiff(new Uint8Array(4), new Uint8Array(5))).toBe(Number.POSITIVE_INFINITY);
  });

  it("turns RGBA into BT.601 luma", () => {
    expect(Array.from(lumaFromRgba([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255]))).toEqual([
      0, 255, 76,
    ]);
  });
});

describe("judgePicture: what must fire", () => {
  it("a black capture, after 8 s", () => {
    expect(judgePicture(run(4, blackCapture))).toBe("ok"); // 6 s of evidence
    expect(judgePicture(run(5, blackCapture))).toBe("black"); // 8 s
  });

  it("a black capture with the pointer drawn on it", () => {
    expect(judgePicture(run(6, blackCaptureWithCursor))).toBe("black");
  });

  it("a black capture that arrives slowly (few frames, same zeros)", () => {
    expect(judgePicture(run(6, blackCapture, (i) => (i % 2 === 0 ? 1 : 0)))).toBe("black");
  });

  it("a game frame that froze: motion, then the capturer hands over nothing", () => {
    const samples = run(9, gameFrame, (i) => (i < 3 ? 60 : 0));
    // Frames stop after sample 2 (t = 4 s): quiet once 8 s have passed with
    // the count unchanged, at t = 12 s.
    expect(judgePicture(samples.slice(0, 6))).toBe("ok");
    expect(judgePicture(samples.slice(0, 7))).toBe("quiet");
  });

  it("a capture that never delivered a frame at all", () => {
    expect(judgePicture(run(5, gameFrame, () => 0))).toBe("quiet");
  });

  it("a still slide under zero-hertz capture is QUIET too, which is why QUIET needs the shell", () => {
    // Chromium 152 delivers no frame whose content did not change: one frame,
    // then nothing. Indistinguishable from a frozen game by frames or pixels,
    // so `share-picture-watch.test.ts` pins that the watch never reports it
    // without the shell saying an exclusive-fullscreen app is running.
    expect(judgePicture(run(6, slide, (i) => (i === 0 ? 1 : 0)))).toBe("quiet");
  });
});

describe("judgePicture: what must not fire", () => {
  it("a dark film scene, however long", () => {
    expect(judgePicture(run(30, darkFilm))).toBe("ok");
  });

  it("a near-black film scene with one light source", () => {
    expect(judgePicture(run(30, nearBlackFilm))).toBe("ok");
  });

  it("a fade to black shorter than the window", () => {
    const picture = (i: number) => (i >= 3 && i < 6 ? blackCapture() : darkFilm(i));
    expect(judgePicture(run(12, picture))).toBe("ok");
  });

  it("a still slide (identical frames that keep arriving)", () => {
    expect(judgePicture(run(30, slide))).toBe("ok");
  });

  it("a still slide that the capturer refreshes now and then", () => {
    // One frame every other sample (a refresh request) is frames arriving.
    expect(judgePicture(run(30, slide, (i) => (i % 2 === 0 ? 1 : 0)))).toBe("ok");
  });

  it("a game in motion", () => {
    expect(judgePicture(run(30, gameFrame))).toBe("ok");
  });

  it("a muted track (Chromium says the source has nothing for now)", () => {
    expect(
      judgePicture(run(12, gameFrame, (i) => (i < 2 ? 60 : 0), (i) => i >= 2)),
    ).toBe("ok");
  });

  it("an engine that cannot count frames never concludes quiet", () => {
    const samples = run(12, gameFrame, () => 0).map((s) => ({ ...s, frames: null }));
    expect(judgePicture(samples)).toBe("ok");
  });

  it("black that ends: one moving frame starts the evidence over", () => {
    // Black for 0..10 s, one moving frame at 12 s, black again from 14 s.
    const picture = (i: number) => (i === 6 ? gameFrame(i) : blackCapture());
    // Without that frame, 0..20 s would long since be black; with it, the
    // run starts at 14 s and 14..20 s is 6 s: not yet.
    expect(judgePicture(run(11, picture))).toBe("ok");
    // 14..22 s is 8 s: now it is.
    expect(judgePicture(run(12, picture))).toBe("black");
  });

  it("uses the documented defaults", () => {
    expect(DEFAULT_PICTURE_THRESHOLDS).toEqual({
      sustainMs: 8_000,
      blackMean: 4,
      blackP98: 12,
      blackStillDiff: 0.75,
    });
  });
});

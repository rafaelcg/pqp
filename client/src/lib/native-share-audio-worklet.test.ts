import { describe, expect, it } from "vitest";
import { JITTER_DEFAULTS, PcmJitterBuffer } from "./native-share-audio-worklet.js";

/** `frames` of interleaved stereo, left = value, right = -value. */
function chunk(frames: number, value: number): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    out[2 * i] = value;
    out[2 * i + 1] = -value;
  }
  return out;
}

function quantum(buffer: PcmJitterBuffer) {
  const left = new Float32Array(128).fill(9);
  const right = new Float32Array(128).fill(9);
  buffer.pull(left, right);
  return { left, right };
}

describe("PcmJitterBuffer", () => {
  it("stays silent until 20 ms is in hand, then plays both channels", () => {
    const buffer = new PcmJitterBuffer();
    buffer.push(chunk(480, 0.5));
    expect(quantum(buffer).left.every((x) => x === 0)).toBe(true);
    buffer.push(chunk(480, 0.5));
    const { left, right } = quantum(buffer);
    expect(left.every((x) => x === 0.5)).toBe(true);
    expect(right.every((x) => x === -0.5)).toBe(true);
    expect(buffer.bufferedFrames).toBe(960 - 128);
  });

  it("pads a dry quantum with silence, never stale samples, and primes again", () => {
    const buffer = new PcmJitterBuffer({ startFrames: 64 });
    buffer.push(chunk(100, 0.25));
    const { left } = quantum(buffer);
    expect(left.slice(0, 100).every((x) => x === 0.25)).toBe(true);
    expect(left.slice(100).every((x) => x === 0)).toBe(true);
    expect(buffer.underflows).toBe(1);
    expect(buffer.playing).toBe(false);
    buffer.push(chunk(32, 0.25));
    expect(quantum(buffer).left.every((x) => x === 0)).toBe(true);
  });

  it("skips forward when the capture runs ahead, so the sound never drifts late", () => {
    const buffer = new PcmJitterBuffer();
    for (let i = 0; i < 20; i += 1) {
      buffer.push(chunk(480, i / 100));
    }
    expect(buffer.bufferedFrames).toBe(9600);
    quantum(buffer);
    expect(buffer.bufferedFrames).toBe(JITTER_DEFAULTS.targetFrames - 128);
    expect(buffer.skippedFrames).toBe(9600 - JITTER_DEFAULTS.targetFrames);
  });

  it("keeps the newest audio when the page stalls past its capacity", () => {
    const buffer = new PcmJitterBuffer({ capacityFrames: 1000, maxFrames: 100000 });
    buffer.push(chunk(800, 0.1));
    buffer.push(chunk(800, 0.9));
    expect(buffer.bufferedFrames).toBe(1000);
    const { left } = quantum(buffer);
    // 600 of the old chunk were dropped, the 200 that remain come first.
    expect(left[0]).toBeCloseTo(0.1);
    buffer.pull(new Float32Array(72), new Float32Array(72));
    const next = quantum(buffer);
    expect(next.left[0]).toBeCloseTo(0.9);
  });

  it("wraps around the ring without tearing a frame", () => {
    const buffer = new PcmJitterBuffer({ capacityFrames: 300, startFrames: 1, maxFrames: 100000 });
    for (let round = 0; round < 10; round += 1) {
      buffer.push(chunk(128, round));
      const { left, right } = quantum(buffer);
      expect(left.every((x) => x === round)).toBe(true);
      expect(right.every((x) => x === -round || (round === 0 && x === 0))).toBe(true);
    }
  });
});

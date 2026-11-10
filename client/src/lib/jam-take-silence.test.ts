import { describe, expect, it } from "vitest";
import { isSilentTake, SILENT_PEAK, takePeak } from "./jam-take-silence";

const SR = 48_000;

function take(seconds: number, fill: (index: number) => number) {
  const samples = new Float32Array(seconds * SR);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = fill(index);
  }
  return { samples, sampleRate: SR, durationMs: seconds * 1000 };
}

describe("a take that is silent from start to finish", () => {
  it("is a flat line, however long", () => {
    expect(isSilentTake(take(5, () => 0), { trimStartMs: 0, trimEndMs: 0 })).toBe(true);
  });

  it("is the noise floor of a live input, which never gets near the threshold", () => {
    const noise = take(5, (index) => 0.0015 * Math.sin(index * 0.37));
    expect(isSilentTake(noise, { trimStartMs: 0, trimEndMs: 0 })).toBe(true);
  });

  it("is not quiet playing: a soft note at -30 dBFS is not flagged", () => {
    const soft = take(5, (index) => (index > 2 * SR && index < 2.2 * SR ? 0.03 * Math.sin(index * 0.05) : 0));
    expect(isSilentTake(soft, { trimStartMs: 0, trimEndMs: 0 })).toBe(false);
  });

  it("is judged by one sample at the threshold: a single click above it is sound", () => {
    const click = take(3, (index) => (index === SR ? SILENT_PEAK * 1.5 : 0));
    expect(isSilentTake(click, { trimStartMs: 0, trimEndMs: 0 })).toBe(false);
  });

  it("does not count the trimmed count-in, which leaks into a microphone", () => {
    // Loud in the first second (the count-in), silent after it.
    const leaked = take(4, (index) => (index < SR ? 0.5 : 0));
    expect(isSilentTake(leaked, { trimStartMs: 0, trimEndMs: 0 })).toBe(false);
    expect(isSilentTake(leaked, { trimStartMs: 1000, trimEndMs: 0 })).toBe(true);
  });

  it("does not count a trimmed tail either, and a take trimmed to nothing is silent", () => {
    const tail = take(4, (index) => (index > 3 * SR ? 0.5 : 0));
    expect(isSilentTake(tail, { trimStartMs: 0, trimEndMs: 1000 })).toBe(true);
    expect(isSilentTake(tail, { trimStartMs: 4000, trimEndMs: 0 })).toBe(true);
  });

  it("measures only the asked stretch", () => {
    const x = take(2, (index) => (index > SR ? 0.4 : 0.001));
    expect(takePeak(x.samples, SR, 0, 900)).toBeLessThan(0.01);
    expect(takePeak(x.samples, SR, 1100, 2000)).toBeCloseTo(0.4, 5);
  });
});

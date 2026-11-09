import { describe, expect, it } from "vitest";
import { assembleChunks, chooseMono, shiftStart, type StampedChunk } from "./assemble";
import { CaptureCollector } from "./capture-worklet.js";
import { CAPTURE_PROCESSOR_NAME } from "./input";
import { CAPTURE_PROCESSOR } from "./capture-worklet.js";
import { analyseLoopback, analyseTapAlong } from "./latency";
import { quantize } from "./pcm";
import { takeOffsetMs, wholeMillisecondOffset } from "./placement";
import { metronomeClick, pulseTrain, sweep } from "./signals";
import { planSegment } from "./timeline";
import { findPulse } from "./xcorr";

/**
 * The whole latency pipeline in Node, with a SIMULATED round trip.
 *
 * A virtual AudioContext clock runs render quanta of 128 frames. "Output" is
 * whatever was scheduled; the microphone hears it `L` frames later (plus a
 * wall reflection and hiss). The capture goes through the real
 * `CaptureCollector` (the worklet's logic) and the real assembler, then the
 * real analysis and placement code. A "player" plays a note exactly when they
 * HEAR each backing click, which is the assumption every DAW's latency
 * compensation makes. If the arithmetic anywhere is off by a quantum, a sign
 * or a unit, the notes miss the clicks and this fails.
 *
 * What it cannot prove: that a real browser's frame stamps behave like
 * these. That is the Playwright spec's job (e2e/jam/).
 */

const SR = 48000;
const Q = 128;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** Run the capture over `mic` (indexed by context frame) from `atFrame`, the way the worklet would. */
function captureFrom(mic: Float32Array, atFrame: number, channels = 1): ReturnType<typeof assembleChunks> {
  const c = new CaptureCollector({ batchFrames: 4096 });
  c.start(atFrame, channels);
  const chunks: StampedChunk[] = [];
  for (let frame = 0; frame + Q <= mic.length; frame += Q) {
    const block = mic.subarray(frame, frame + Q);
    const input = channels === 2 ? [block, new Float32Array(Q)] : [block];
    const out = c.push(input, frame, Q);
    if (out) chunks.push(out);
  }
  const last = c.stop();
  if (last) chunks.push(last);
  return assembleChunks(chunks);
}

/** What the microphone hears: `out` delayed by `lag` frames, attenuated, a reflection, hiss. */
function room(out: Float32Array, lag: number, seed = 1): Float32Array {
  const r = rng(seed);
  const mic = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const direct = i - lag >= 0 ? out[i - lag] : 0;
    const wall = i - lag - 290 >= 0 ? out[i - lag - 290] : 0; // ~6 ms later, LOUDER than direct
    mic[i] = -0.25 * direct + 0.35 * wall + r() * 0.02;
  }
  return mic;
}

describe("capture worklet logic", () => {
  it("names the same processor the node constructor uses", () => {
    expect(CAPTURE_PROCESSOR).toBe(CAPTURE_PROCESSOR_NAME);
  });

  it("starts on the quantum holding atFrame, stamps every chunk, records silence for missing input", () => {
    const c = new CaptureCollector({ batchFrames: 512 });
    c.start(300, 1);
    const got: StampedChunk[] = [];
    for (let f = 0; f < 2048; f += Q) {
      const out = c.push(f === 768 ? [] : [new Float32Array(Q).fill(f)], f, Q);
      if (out) got.push(out);
    }
    const last = c.stop();
    if (last) got.push(last);
    expect(got[0].frame).toBe(256);
    const a = assembleChunks(got)!;
    expect(a.startFrame).toBe(256);
    expect(a.gapFrames).toBe(0);
    expect(a.channels[0].length).toBe(2048 - 256);
    expect(a.channels[0][768 - 256]).toBe(0); // the empty quantum is silence, not skipped
    expect(a.channels[0][1024 - 256]).toBe(1024);
  });
});

describe("loopback analysis", () => {
  it("finds a simulated round trip to a fraction of a sample, ignoring a louder reflection and polarity", () => {
    for (const lag of [137, 1234, 9876]) {
      const ref = sweep(SR, { direction: "down" });
      const t0 = 10_000;
      const period = Math.round(0.6 * SR);
      const emitted = Array.from({ length: 10 }, (_, k) => t0 + Math.round(0.3 * SR) + k * period);
      const out = pulseTrain(t0 + 8 * SR, ref, emitted);
      const cap = captureFrom(room(out, lag, lag), t0)!;
      const result = analyseLoopback({
        captured: cap.channels[0],
        captureStartFrame: cap.startFrame,
        emittedFrames: emitted,
        reference: ref,
        sampleRate: SR,
        maxLatencyMs: 550,
      });
      expect(result.confidence).toBe("high");
      expect(result.accepted).toBe(10);
      expect(Math.abs(result.roundTripMs - (lag / SR) * 1000)).toBeLessThan(0.01);
    }
  });

  it("fails cleanly when the microphone hears nothing", () => {
    const ref = sweep(SR);
    const r = rng(3);
    const hiss = Float32Array.from({ length: 5 * SR }, () => r() * 0.01);
    const result = analyseLoopback({
      captured: hiss,
      captureStartFrame: 0,
      emittedFrames: [1000, 30_000, 60_000, 90_000],
      reference: ref,
      sampleRate: SR,
      maxLatencyMs: 550,
    });
    expect(result.confidence).toBe("failed");
    expect(result.note).toMatch(/did not hear/);
  });
});

describe("tap-along analysis", () => {
  it("recovers latency from human-jittered taps and rates it medium, ignoring the warm-up taps", () => {
    const r = rng(11);
    const clickFrames = Array.from({ length: 12 }, (_, k) => 24_000 + k * 28_800);
    const latencyMs = 23;
    const len = clickFrames[11] + SR;
    const tap = metronomeClick(SR, true);
    const at = clickFrames.map((c, k) => {
      const human = k < 2 ? 70 : r() * 6; // two sloppy warm-up taps, then +-3 ms
      return c + Math.round(((latencyMs + human) / 1000) * SR);
    });
    const captured = pulseTrain(len, tap, at);
    for (let i = 0; i < len; i++) captured[i] += r() * 0.002;
    const res = analyseTapAlong({ captured, captureStartFrame: 0, clickFrames, sampleRate: SR });
    expect(res.confidence).toBe("medium");
    expect(Math.abs(res.roundTripMs - latencyMs)).toBeLessThan(2.5);
    expect(res.accepted).toBeGreaterThanOrEqual(9);
  });
});

describe("the whole take, simulated", () => {
  it("calibrate, record over a backing with a count-in, encode, place: notes land on the clicks", () => {
    const lag = 1873; // 39.02 ms round trip, not a whole ms, not a whole quantum
    const ref = sweep(SR, { direction: "down" });

    // 1. calibration on the virtual clock
    const calT0 = 4096;
    const period = Math.round(0.6 * SR);
    const emitted = Array.from({ length: 10 }, (_, k) => calT0 + Math.round(0.3 * SR) + k * period);
    const calCap = captureFrom(room(pulseTrain(calT0 + 7 * SR, ref, emitted), lag, 5), calT0)!;
    const lat = analyseLoopback({
      captured: calCap.channels[0],
      captureStartFrame: calCap.startFrame,
      emittedFrames: emitted,
      reference: ref,
      sampleRate: SR,
      maxLatencyMs: 550,
    });
    expect(lat.confidence).toBe("high");

    // 2. a take: count-in of 4 beats at 120 BPM, backing from song 3000 ms
    const fromMs = 3000;
    const t0 = 20_011; // capture starts mid-quantum on purpose
    const beat = 24_000;
    const f0 = t0 + 4 * beat;
    const backingClicksSong = [3000, 3500, 4000, 4500, 5000, 5500];
    const backingFrames = backingClicksSong.map((s) => f0 + Math.round(((s - fromMs) / 1000) * SR));
    // the player hears each click `lag` frames after it leaves the graph and
    // plays on it; the microphone stamps their note another... no: `lag` IS
    // output + input, so the note is captured at click + lag
    const note = sweep(SR, { direction: "up", amplitude: 0.7 });
    const total = f0 + 4 * SR;
    const mic = pulseTrain(total, note, backingFrames.map((f) => f + lag));
    const cap = captureFrom(mic, t0, 2)!; // a two-input interface, guitar on the left
    const mono = chooseMono(cap.channels);
    expect(mono.choice).toBe("left");

    const raw = takeOffsetMs({
      sampleRate: SR,
      fromMs,
      backingStartFrame: f0,
      captureStartFrame: cap.startFrame,
      roundTripMs: lat.roundTripMs,
    });
    const whole = wholeMillisecondOffset(raw, SR);
    expect(Number.isInteger(whole.offsetMs)).toBe(true);
    const samples = shiftStart(mono.samples, whole.dropFrames);

    // 3. the upload round trip: FLAC is lossless, so it is exactly the 16-bit grid
    const decoded = Float32Array.from(quantize(samples, 16), (v) => v / 32768);

    // 4. where each note now sits on the song
    for (const s of backingClicksSong) {
      const expectAt = ((s - whole.offsetMs) / 1000) * SR;
      const m = findPulse(decoded, note, expectAt - 2000, expectAt + 2000)!;
      const songMs = whole.offsetMs + (m.position / SR) * 1000;
      expect(Math.abs(songMs - s)).toBeLessThan(0.02);
    }

    // 5. and the player would start it there: buffer sample j at round((offset-from)*sr)+j
    const [entry] = planSegment(
      [{ id: "take", timing: { offsetMs: whole.offsetMs, trimStartMs: fromMs - whole.offsetMs, trimEndMs: 0, durationMs: (decoded.length / SR) * 1000 } }],
      fromMs,
      fromMs + 3000,
      SR,
    );
    expect(entry.startFrame).toBe(0);
    expect(entry.bufferOffsetFrames).toBe(Math.round(((fromMs - whole.offsetMs) / 1000) * SR));
  });
});

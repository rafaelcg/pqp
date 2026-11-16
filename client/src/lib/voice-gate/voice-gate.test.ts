import { describe, expect, it, vi } from "vitest";
import {
  buildScene,
  FIXTURE_SAMPLE_RATE,
  peakDb,
  rms,
  rmsDb,
  type Scene,
} from "./fixtures.ts";
import {
  align,
  gapReductionDb,
  gapWindows,
  keyboardInGaps,
  keyboardPeakReductionDb,
  onsetLossDb,
  wordLossDb,
} from "./metrics.ts";
import { VOICE_GATE_DEFAULTS, VoiceGate } from "./voice-gate-worklet.js";

/**
 * THE BENCH, AS ASSERTIONS.
 *
 * `client/bench/voice-gate-bench.mjs` prints the full comparison (RNNoise,
 * GTCRN, with and without the gate); this file pins what the gate on its own
 * must keep doing, on deterministic audio from `fixtures.ts`, so a change that
 * makes it clip a word or stop quieting a gap fails here and not in a call.
 *
 * Every number is measured, never assumed: gap reduction against the raw
 * microphone, onset loss in the first 40 ms of each word, latency by
 * cross-correlation. The voice is synthetic, which is a limit of what these
 * can prove and is said so in `docs/NOISE_SUPPRESSION.md`.
 */

const SR = FIXTURE_SAMPLE_RATE;

interface RunOptions {
  /** Detector signal, when it is not the audio itself. */
  sidechain?: Float32Array;
  config?: Partial<typeof VOICE_GATE_DEFAULTS>;
  bypass?: boolean;
  quantum?: number;
}

function run(signal: Float32Array, options: RunOptions = {}) {
  const gate = new VoiceGate({ sampleRate: SR, ...options.config });
  gate.setBypass(options.bypass === true);
  const quantum = options.quantum ?? 128;
  const out = new Float32Array(signal.length);
  for (let at = 0; at < signal.length; at += quantum) {
    const n = Math.min(quantum, signal.length - at);
    const frame = signal.subarray(at, at + n);
    const o = new Float32Array(n);
    gate.process(
      [frame],
      [o],
      options.sidechain ? [options.sidechain.subarray(at, at + n)] : undefined,
    );
    out.set(o, at);
  }
  return { out, gate };
}

function measure(scene: Scene, bypass = false) {
  const { out, gate } = run(scene.mix, { bypass });
  const aligned = align(out, gate.latencySamples);
  const gaps = gapWindows(scene);
  const keys = keyboardInGaps(scene, gaps);
  return {
    gate,
    aligned,
    gapDb: gapReductionDb(scene.mix, aligned, gaps),
    keyDb: keyboardPeakReductionDb(scene.mix, aligned, keys),
    onset: onsetLossDb(scene, scene.mix, aligned),
    words: wordLossDb(scene, scene.mix, aligned),
  };
}

const worst = (xs: (number | null)[]) =>
  Math.min(...xs.filter((x): x is number => x !== null));

describe("the fixtures themselves", () => {
  it("are deterministic: the same seed is the same samples", () => {
    const a = buildScene({ seed: 7 });
    const b = buildScene({ seed: 7 });
    const c = buildScene({ seed: 8 });
    expect(Array.from(a.mix.subarray(100_000, 100_010))).toEqual(
      Array.from(b.mix.subarray(100_000, 100_010)),
    );
    expect(Array.from(a.mix.subarray(100_000, 100_010))).not.toEqual(
      Array.from(c.mix.subarray(100_000, 100_010)),
    );
  });

  it("have the levels the metrics assume", () => {
    const scene = buildScene();
    expect(rmsDb(scene.fan)).toBeCloseTo(-48, 0);
    const first = scene.words[0];
    const from = Math.round(first.start * SR);
    const to = Math.round(first.end * SR);
    // The words sit around -22 dBFS RMS, far above the fan.
    expect(rmsDb(scene.speech, from, to)).toBeGreaterThan(-26);
    expect(rmsDb(scene.speech, from, to)).toBeLessThan(-14);
    // Clicks are short and sit at the level they were asked for.
    expect(peakDb(scene.keyboard)).toBeLessThan(-35);
    expect(peakDb(scene.keyboard)).toBeGreaterThan(-45);
  });
});

describe("latency", () => {
  it("adds exactly the lookahead, measured: an impulse comes out 8 ms later", () => {
    const impulse = new Float32Array(SR);
    impulse[20_000] = 0.5;
    const { out, gate } = run(impulse);
    let at = -1;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]) > 0.1) {
        at = i;
        break;
      }
    }
    expect(gate.latencySamples).toBe(384);
    expect(at - 20_000).toBe(384);
    // Under the ~10 ms budget the call has for anything it adds.
    expect((384 / SR) * 1000).toBeLessThanOrEqual(10);
  });

  it("adds none with a sidechain, where the suppressor's own delay is the lookahead", () => {
    const gate = new VoiceGate({ sampleRate: SR, lookaheadMs: 0 });
    expect(gate.latencySamples).toBe(0);
    const input = new Float32Array(256).fill(0.25);
    const out = new Float32Array(256);
    gate.process([input], [out]);
    // Open at the start, so the signal goes straight through, undelayed.
    expect(out[0]).toBeCloseTo(0.25, 5);
    expect(out[255]).toBeCloseTo(0.25, 5);
  });

  it("scales the lookahead with the context's sample rate", () => {
    expect(new VoiceGate({ sampleRate: 44100 }).latencySamples).toBe(353);
    expect(new VoiceGate({ sampleRate: 16000 }).latencySamples).toBe(128);
  });
});

describe("on a room with a fan and a keyboard", () => {
  it("turns the gaps down by about the range, and no further (an expander, not a mute)", () => {
    const m = measure(buildScene());
    expect(m.gapDb).toBeGreaterThan(15);
    // A closed gate settles at rangeDb (-20 dB). More than that and it has
    // become the walkie-talkie.
    expect(m.gapDb).toBeLessThan(22);
  });

  it("does not clip the start of a single word", () => {
    const m = measure(buildScene());
    // Energy in the first 40 ms of each word, out over in. 0 dB is none lost.
    expect(worst(m.onset)).toBeGreaterThan(-1);
    expect(worst(m.words)).toBeGreaterThan(-0.5);
  });

  it("does not clip a word that starts with a fricative", () => {
    const scene = buildScene();
    const m = measure(scene);
    const fricative = scene.words
      .map((w, i) => (w.fricativeMs > 0 ? i : -1))
      .filter((i) => i >= 0);
    expect(fricative.length).toBeGreaterThan(0);
    for (const i of fricative) {
      expect(m.onset[i]).not.toBeNull();
      expect(m.onset[i] as number).toBeGreaterThan(-1);
    }
  });

  it("rejects key clicks as transients, loud ones included", () => {
    for (const keyboardPeakDb of [-38, -28]) {
      const m = measure(buildScene({ keyboardPeakDb }));
      expect(m.keyDb).toBeGreaterThan(12);
      expect(worst(m.onset)).toBeGreaterThan(-1);
    }
  });

  it("still holds a word's onset in a louder room (fan at -40 dBFS)", () => {
    const m = measure(buildScene({ fanDb: -40, keyboardPeakDb: -30 }));
    expect(m.gapDb).toBeGreaterThan(15);
    expect(worst(m.onset)).toBeGreaterThan(-1.5);
    expect(worst(m.words)).toBeGreaterThan(-0.5);
  });

  it("learns the room: the floor ends up within a few dB of the fan", () => {
    const scene = buildScene();
    const { gate } = run(scene.mix);
    expect(gate.floorDb).toBeGreaterThan(-54);
    expect(gate.floorDb).toBeLessThan(-44);
  });

  it("is the same on any render quantum size", () => {
    const scene = buildScene({ seconds: 6 });
    const a = run(scene.mix, { quantum: 128 }).out;
    const b = run(scene.mix, { quantum: 100 }).out;
    for (let i = 0; i < a.length; i += 997) {
      expect(b[i]).toBeCloseTo(a[i], 5);
    }
  });
});

describe("a closed gate is gentle", () => {
  it("never steps its gain: every sample's change is small, release included", () => {
    const scene = buildScene({ seconds: 8 });
    const gate = new VoiceGate({ sampleRate: SR });
    let previous = 1;
    let biggest = 0;
    let closed = 0;
    for (let at = 0; at < scene.mix.length; at += 1) {
      gate.process([scene.mix.subarray(at, at + 1)], [new Float32Array(1)]);
      biggest = Math.max(biggest, Math.abs(gate.gain - previous));
      previous = gate.gain;
      if (!gate.isOpen) {
        closed += 1;
      }
    }
    expect(closed).toBeGreaterThan(SR); // it did close, more than a second of it
    // The attack's time constant is 0.6 ms, so the largest single-sample move
    // is a few percent: a ramp, never a cut.
    expect(biggest).toBeLessThan(0.06);
  });

  it("settles at the range and no lower, so the noise floor never drops to nothing", () => {
    const scene = buildScene({ seconds: 6 });
    const { gate } = run(scene.mix);
    expect(gate.isOpen).toBe(false);
    expect(gate.gain).toBeGreaterThan(0.09);
    expect(gate.gain).toBeLessThan(0.11);
  });

  it("opens fast and releases slowly: 60 ms, not a gate slam", () => {
    const gate = new VoiceGate({ sampleRate: SR, lookaheadMs: 0, initialOpenMs: 0 });
    const noise = new Float32Array(SR);
    for (let i = 0; i < noise.length; i++) {
      noise[i] = 0.002 * Math.sin(i * 0.05);
    }
    gate.process([noise], [new Float32Array(noise.length)]);
    expect(gate.isOpen).toBe(false);
    // A loud tone arrives: within 10 ms the gain is back to ~1.
    const tone = new Float32Array(480);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = 0.3 * Math.sin(i * 0.1);
    }
    gate.process([tone], [new Float32Array(480)]);
    expect(gate.isOpen).toBe(true);
    expect(gate.gain).toBeGreaterThan(0.95);
  });
});

describe("it never silences a microphone", () => {
  it("starts open, so the first words of a call are not held while it learns the room", () => {
    const scene = buildScene();
    // Speak straight away: a word at 0.1 s, before any floor exists.
    const early = new Float32Array(SR);
    const word = scene.words[0];
    const src = Math.round(word.start * SR);
    for (let i = 0; i < 0.5 * SR; i++) {
      early[Math.round(0.1 * SR) + i] = scene.speech[src + i];
    }
    const { out, gate } = run(early);
    const at = Math.round(0.1 * SR);
    const heard = rms(out, at + gate.latencySamples, at + 0.5 * SR);
    const sent = rms(early, at, at + 0.5 * SR - gate.latencySamples);
    expect(20 * Math.log10(heard / sent)).toBeGreaterThan(-0.5);
  });

  it("bypass pins it open: no expansion at all, only the lookahead", () => {
    const m = measure(buildScene(), true);
    expect(Math.abs(m.gapDb)).toBeLessThan(0.1);
    expect(worst(m.onset)).toBeGreaterThan(-0.1);
  });

  it("can be bypassed and un-bypassed live without a discontinuity", () => {
    const scene = buildScene({ seconds: 8 });
    const gate = new VoiceGate({ sampleRate: SR });
    let previous = 1;
    let biggest = 0;
    for (let at = 0; at < scene.mix.length; at += 1) {
      if (at === 4 * SR) {
        gate.setBypass(true);
      }
      if (at === 6 * SR) {
        gate.setBypass(false);
      }
      gate.process([scene.mix.subarray(at, at + 1)], [new Float32Array(1)]);
      biggest = Math.max(biggest, Math.abs(gate.gain - previous));
      previous = gate.gain;
    }
    expect(biggest).toBeLessThan(0.06);
  });

  it("digital silence (a muted or hardware-gated mic) does not teach it a floor of nothing", () => {
    const scene = buildScene({ seconds: 6 });
    const input = new Float32Array(2 * SR + 3 * SR);
    input.set(scene.fan.subarray(0, 3 * SR), 2 * SR);
    const { gate } = run(input);
    // Two seconds of zeros and then a fan: the fan is the room, so the gate
    // closes on it. Learning -80 dBFS from the zeros would keep it open for
    // the whole three-second window.
    expect(gate.isOpen).toBe(false);
    expect(gate.floorDb).toBeGreaterThan(-56);
  });

  it("is not poisoned by a NaN: the next word still opens it", () => {
    const scene = buildScene({ seconds: 6 });
    const bad = new Float32Array(scene.mix);
    for (let i = 0; i < 480; i++) {
      bad[Math.round(0.5 * SR) + i] = Number.NaN;
    }
    const { out, gate } = run(bad);
    expect(Number.isFinite(gate.floorDb)).toBe(true);
    // The word at 2.6 s still comes through.
    const from = Math.round(2.7 * SR) + gate.latencySamples;
    expect(rmsDb(out, from, from + 0.2 * SR)).toBeGreaterThan(-35);
  });

  it("handles stereo with one gain for both channels", () => {
    const scene = buildScene({ seconds: 4 });
    const gate = new VoiceGate({ sampleRate: SR });
    const left = scene.mix;
    const right = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      right[i] = left[i] * 0.5;
    }
    const outL = new Float32Array(left.length);
    const outR = new Float32Array(left.length);
    for (let at = 0; at < left.length; at += 128) {
      const n = Math.min(128, left.length - at);
      const oL = new Float32Array(n);
      const oR = new Float32Array(n);
      gate.process(
        [left.subarray(at, at + n), right.subarray(at, at + n)],
        [oL, oR],
      );
      outL.set(oL, at);
      outR.set(oR, at);
    }
    for (let i = 20_000; i < left.length; i += 1013) {
      expect(outR[i]).toBeCloseTo(outL[i] * 0.5, 6);
    }
  });

  it("does nothing, harmlessly, with no channels", () => {
    const gate = new VoiceGate({ sampleRate: SR });
    expect(() => gate.process([], [])).not.toThrow();
  });
});

describe("the worklet processor wrapper", () => {
  async function loadProcessor() {
    vi.resetModules();
    const registered: Record<string, new (init?: unknown) => {
      process(i: Float32Array[][], o: Float32Array[][]): boolean;
      port: { onmessage: ((e: { data: unknown }) => void) | null };
    }> = {};
    vi.stubGlobal("sampleRate", SR);
    vi.stubGlobal(
      "AudioWorkletProcessor",
      class {
        port = { onmessage: null as ((e: { data: unknown }) => void) | null };
      },
    );
    vi.stubGlobal("registerProcessor", (name: string, ctor: never) => {
      registered[name] = ctor;
    });
    await import("./voice-gate-worklet.js");
    return registered;
  }

  it("registers under the name the node asks for and fails open if the DSP throws", async () => {
    const registered = await loadProcessor();
    try {
      const Processor = registered["pqp-voice-gate"];
      expect(Processor).toBeDefined();
      const processor = new Processor({ processorOptions: { lookaheadMs: 0 } });
      const input = new Float32Array(128).fill(0.2);
      const output = new Float32Array(128);
      expect(processor.process([[input]], [[output]])).toBe(true);
      expect(output[5]).toBeCloseTo(0.2, 5);

      // Break the DSP: the processor must become a wire, not a silence.
      (processor as unknown as { gate: { process: () => never } }).gate.process = () => {
        throw new Error("boom");
      };
      const out2 = new Float32Array(128);
      expect(processor.process([[input]], [[out2]])).toBe(true);
      expect(out2[5]).toBeCloseTo(0.2, 5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("takes a bypass message from the main thread", async () => {
    const registered = await loadProcessor();
    try {
      const Processor = registered["pqp-voice-gate"];
      const processor = new Processor({ processorOptions: { lookaheadMs: 0 } });
      processor.port.onmessage?.({ data: { bypass: true } });
      // A long stretch of nothing: an un-bypassed gate would close and settle
      // at -20 dB; a bypassed one keeps passing the signal.
      const quiet = new Float32Array(128).fill(0.0003);
      let out = new Float32Array(128);
      for (let i = 0; i < 400; i++) {
        out = new Float32Array(128);
        processor.process([[quiet]], [[out]]);
      }
      expect(out[10]).toBeCloseTo(0.0003, 6);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("outputs nothing and does not throw when nothing is connected", async () => {
    const registered = await loadProcessor();
    try {
      const Processor = registered["pqp-voice-gate"];
      const processor = new Processor({ processorOptions: {} });
      expect(processor.process([[]], [[new Float32Array(128)]])).toBe(true);
      expect(processor.process([], [[new Float32Array(128)]])).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

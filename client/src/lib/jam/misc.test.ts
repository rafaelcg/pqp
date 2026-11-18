import { describe, expect, it } from "vitest";
import { assembleChunks, chooseMono, shiftStart } from "./assemble";
import {
  LatencyStore,
  assessOutput,
  chooseLatency,
  devicePairKey,
  estimateFromReported,
  type KeyValueStore,
  type LatencyResult,
} from "./latency";
import { computePeaks, MAX_PEAKS } from "./peaks";
import { encodeWav } from "./pcm";
import { sampleToSongMs, takeOffsetMs, wholeMillisecondOffset } from "./placement";
import { pulseTrain, sweep } from "./signals";
import { countInClicks, countInFrames, tapTempo } from "./tempo";
import { decideVideo } from "./video-sync";
import { alignVideoAudio, pickVideoMime } from "./video-take";
import { detectOnsets, findPulse, locate, parabolicOffset } from "./xcorr";

describe("cross-correlation", () => {
  it("finds a pulse at a fractional position", () => {
    const ref = sweep(48000, { direction: "down" });
    const sig = pulseTrain(20_000, ref, [7_321]);
    const m = findPulse(sig, ref, 0, 19_000)!;
    expect(m.position).toBeCloseTo(7321, 1);
    expect(m.quality).toBeGreaterThan(0.99);
  });

  it("parabolic offset is the vertex", () => {
    // y = -(x - 0.3)^2 at x = -1, 0, 1
    expect(parabolicOffset(-1.69, -0.09, -0.49)).toBeCloseTo(0.3, 6);
  });

  it("an up sweep barely matches a down sweep (the e2e relies on telling them apart)", () => {
    const down = sweep(48000, { direction: "down" });
    const up = sweep(48000, { direction: "up" });
    const sig = pulseTrain(5000, up, [1000]);
    const m = findPulse(sig, down, 0, 4000);
    expect(m!.quality).toBeLessThan(0.3);
  });

  it("FFT locate finds a needle in a haystack", () => {
    let s = 9;
    const hay = Float32Array.from({ length: 30_000 }, () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s / 2 ** 32 - 0.5;
    });
    const needle = hay.slice(12_345, 12_345 + 4000);
    const m = locate(hay, needle)!;
    expect(m.position).toBe(12_345);
    expect(m.quality).toBeCloseTo(1, 5);
  });

  it("onsets are found at the attack", () => {
    const click = new Float32Array(200).map((_, i) => Math.exp(-i / 30) * Math.sin(i));
    const sig = pulseTrain(48_000, click, [5000, 20_000, 33_333]);
    const on = detectOnsets(sig, 48000);
    expect(on.length).toBe(3);
    on.forEach((o, i) => expect(Math.abs(o - [5000, 20_000, 33_333][i])).toBeLessThanOrEqual(2));
  });
});

describe("placement arithmetic", () => {
  it("offset = from + (capture - backing)/sr - roundTrip", () => {
    expect(
      takeOffsetMs({ sampleRate: 48000, fromMs: 1000, backingStartFrame: 96_000, captureStartFrame: 48_000, roundTripMs: 12.5 }),
    ).toBeCloseTo(1000 - 1000 - 12.5, 9);
  });

  it("whole-ms rounding drops under a millisecond of samples and is exact at 48 kHz", () => {
    const r = wholeMillisecondOffset(-2012.5, 48000);
    expect(r).toEqual({ offsetMs: -2012, dropFrames: 24 });
    expect(sampleToSongMs(r.dropFrames, -2012.5, 48000)).toBeCloseTo(-2012, 9);
    expect(wholeMillisecondOffset(7, 48000)).toEqual({ offsetMs: 7, dropFrames: 0 });
    const odd = wholeMillisecondOffset(3.3, 44100);
    expect(odd.offsetMs).toBe(4);
    expect(Math.abs(sampleToSongMs(odd.dropFrames, 3.3, 44100) - 4)).toBeLessThan(1000 / 44100);
  });

  it("shiftStart drops or pads", () => {
    const x = Float32Array.from([1, 2, 3]);
    expect(Array.from(shiftStart(x, 1))).toEqual([2, 3]);
    expect(Array.from(shiftStart(x, -2))).toEqual([0, 0, 1, 2, 3]);
  });
});

describe("mono choice", () => {
  it("keeps the loud side of a one-sided interface and averages a real stereo pair", () => {
    const l = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i));
    const quiet = l.map((v) => v * 0.01);
    expect(chooseMono([l, quiet]).choice).toBe("left");
    expect(chooseMono([quiet, l]).choice).toBe("right");
    expect(chooseMono([l, l.map((v) => v * 0.5)]).choice).toBe("mix");
  });

  it("assembler fills a hole with silence instead of closing it", () => {
    const a = assembleChunks([
      { frame: 0, channels: [new Float32Array(128).fill(1)] },
      { frame: 256, channels: [new Float32Array(128).fill(2)] },
    ])!;
    expect(a.gapFrames).toBe(128);
    expect(a.channels[0][200]).toBe(0);
    expect(a.channels[0][300]).toBe(2);
  });
});

describe("peaks", () => {
  it("at most 400 values in 0..1, the absolute max per slice", () => {
    const x = new Float32Array(10_000);
    x[5000] = -0.75;
    x[9999] = 1.5;
    const p = computePeaks([x]);
    expect(p.length).toBe(MAX_PEAKS);
    expect(p[200]).toBe(0.75);
    expect(p[399]).toBe(1);
    expect(Math.max(...p.slice(0, 200))).toBe(0);
    expect(computePeaks([new Float32Array(10)]).length).toBe(10);
    expect(computePeaks([new Float32Array(0)])).toEqual([]);
  });
});

describe("wav", () => {
  it("writes a canonical header and little-endian samples", () => {
    const w = encodeWav([Float32Array.from([0, 0.5, -1])], 48000);
    const dv = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe("RIFF");
    expect(dv.getUint32(24, true)).toBe(48000);
    expect(dv.getInt16(44, true)).toBe(0);
    expect(dv.getInt16(46, true)).toBe(16384);
    expect(dv.getInt16(48, true)).toBe(-32768);
  });
});

describe("tempo", () => {
  it("count-in frames and accents", () => {
    const c = { bars: 2 as const, beatsPerBar: 3, bpm: 90 };
    expect(countInFrames(c, 48000)).toBe(6 * 32_000);
    expect(countInClicks(c, 48000).map((x) => x.accent)).toEqual([true, false, false, true, false, false]);
    expect(countInFrames(null, 48000)).toBe(0);
  });

  it("tap tempo uses the median interval", () => {
    expect(tapTempo([0, 500])).toBeNull();
    expect(tapTempo([0, 500, 1000, 1500, 2300, 2800])).toBe(120);
  });
});

describe("video sync rule", () => {
  const base = { durationSec: 60, transportPlaying: true, videoPaused: false };
  it("leaves small drift alone, nudges the rate for medium drift, seeks for large", () => {
    expect(decideVideo({ ...base, targetSec: 10, currentSec: 10.01 })).toEqual({ kind: "none", rate: 1 });
    const a = decideVideo({ ...base, targetSec: 10, currentSec: 10.1 });
    expect(a.kind).toBe("rate");
    if (a.kind === "rate") expect(a.rate).toBeCloseTo(0.95);
    const b = decideVideo({ ...base, targetSec: 10, currentSec: 9.97 });
    expect(b.kind).toBe("rate");
    if (b.kind === "rate") expect(b.rate).toBeCloseTo(1.03);
    expect(decideVideo({ ...base, targetSec: 10, currentSec: 11 })).toEqual({ kind: "seek", to: 10, play: true });
  });
  it("parks the picture when paused or outside the clip", () => {
    expect(decideVideo({ ...base, transportPlaying: false, targetSec: 5, currentSec: 7 })).toEqual({ kind: "pause", to: 5 });
    expect(decideVideo({ ...base, targetSec: -2, currentSec: 0, videoPaused: true })).toEqual({ kind: "none", rate: 1 });
    expect(decideVideo({ ...base, targetSec: 70, currentSec: 59 })).toEqual({ kind: "pause", to: 60 });
  });
});

describe("video alignment by content", () => {
  it("finds the file's time zero inside the PCM even when the timestamp guess is 400 ms off", () => {
    const sr = 8000;
    let s = 5;
    const pcm = Float32Array.from({ length: sr * 12 }, () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return (s / 2 ** 32 - 0.5) * 0.5;
    });
    const trueZero = 3_210; // the file starts 0.40 s into the PCM
    const file = pcm.slice(trueZero, trueZero + sr * 8);
    const a = alignVideoAudio(pcm, file, sr, trueZero - 3_200, { windowSec: 1.5 });
    expect(a.method).toBe("content");
    expect(a.zeroFrame).toBe(trueZero);
  });

  it("aligns a take shorter than the 3 s excerpt by content, with a shorter excerpt", () => {
    const sr = 8000;
    let s = 17;
    const pcm = Float32Array.from({ length: Math.round(sr * 2.2) }, () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s / 2 ** 32 - 0.5;
    });
    // the camera file started 0.1 s into the PCM and runs a little past its end
    const trueZero = 800;
    const file = new Float32Array(Math.round(sr * 2.4));
    file.set(pcm.subarray(trueZero));
    const a = alignVideoAudio(pcm, file, sr, trueZero + 120);
    expect(a.method).toBe("content");
    expect(a.zeroFrame).toBe(trueZero);
  });

  it("falls back to the timestamp when there is nothing to match, and says why", () => {
    const a = alignVideoAudio(new Float32Array(48000), new Float32Array(48000), 48000, -120);
    expect(a).toEqual({ zeroFrame: -120, method: "timestamp", quality: 0, timestampGuess: -120, reason: "no-window" });
    expect(alignVideoAudio(new Float32Array(100), new Float32Array(100), 8000, 0).reason).toBe("short");
  });

  // THE CI FLAKE (main, 2026-11-11): method "timestamp" with quality 0 and the
  // guess 107 ms late. The excerpt was the EARLIEST loudest one that fitted the
  // take by the guess; a mic with a bar of sound once a second makes many
  // windows equally loud, so the earliest sat a few ms into the take, and with
  // the guess late the true position was BEFORE the take's first sample: the
  // needle hung off the haystack and the correlation collapsed. Whether it did
  // depended on where the camera started against the take and on which
  // windows came out loudest.
  it("does not pick an excerpt the late guess pushes off the start of the take", () => {
    const sr = 8000;
    let seed = 11;
    const burst = Float32Array.from({ length: sr / 5 }, () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.8;
    });
    const mic = new Float32Array(sr * 60);
    for (let k = 0; k < 59; k++) mic.set(burst, k * sr + sr / 4); // the same 0.2 s of noise, every second
    const failures: string[] = [];
    for (let phaseMs = 0; phaseMs < 1000; phaseMs += 25) {
      const lead = 2.3; // the camera started 2.3 s before the take
      const takeStart = 10 * sr + Math.round((phaseMs / 1000) * sr);
      const trueZero = -Math.round(lead * sr);
      const pcm = mic.slice(takeStart, takeStart + Math.round(9.72 * sr));
      const file = mic.slice(takeStart + trueZero, takeStart + trueZero + Math.round((lead + 9.72) * sr));
      const a = alignVideoAudio(pcm, file, sr, trueZero + Math.round(0.107 * sr)); // the guess, 107 ms late
      if (a.method !== "content" || a.zeroFrame !== trueZero) {
        failures.push(`phase ${phaseMs} ms: ${a.method} ${a.reason ?? ""} q=${a.quality.toFixed(2)} off by ${a.zeroFrame - trueZero}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("on a repeating riff, takes the match nearest the timestamp guess, not just the strongest", () => {
    const sr = 8000;
    let s = 3;
    const bar = Float32Array.from({ length: sr / 2 }, () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s / 2 ** 32 - 0.5;
    });
    const pcm = new Float32Array(sr * 10);
    for (let k = 0; k < 20; k++) pcm.set(bar, k * bar.length); // the same half second, twenty times
    const trueZero = 1234;
    const file = pcm.slice(trueZero, trueZero + sr * 6);
    const a = alignVideoAudio(pcm, file, sr, trueZero + 300); // guess 37 ms late
    expect(a.method).toBe("content");
    expect(a.zeroFrame).toBe(trueZero);
  });

  it("prefers WebM, MP4 where it is all there is (see VIDEO_MIME_PREFERENCE for why)", () => {
    expect(pickVideoMime(() => true)).toBe("video/webm;codecs=vp9,opus");
    expect(pickVideoMime((t) => t === "video/mp4")).toBe("video/mp4");
    expect(pickVideoMime(() => false)).toBeNull();
  });
});

describe("latency choice and storage", () => {
  const mk = (over: Partial<LatencyResult>): LatencyResult => ({
    method: "loopback",
    roundTripMs: 20,
    confidence: "high",
    spreadMs: 0.1,
    accepted: 10,
    played: 10,
    at: 1,
    ...over,
  });

  it("estimate adds what is reported and is never better than low", () => {
    const e = estimateFromReported({ baseLatency: 0.005, outputLatency: 0.02, settingsLatency: 0.01 });
    expect(e.roundTripMs).toBeCloseTo(35, 6);
    expect(e.confidence).toBe("low");
    expect(e.breakdown.inputSource).toBe("settings");
    expect(estimateFromReported({ trackStatsLatencyMs: 0.64, settingsLatency: 0.01 }).breakdown).toEqual({
      baseMs: null,
      outputMs: null,
      inputMs: 0.64,
      inputSource: "track-stats",
    });
    const bare = estimateFromReported({});
    expect(bare.roundTripMs).toBe(10);
    expect(bare.note).toMatch(/does not report its output latency/);
  });

  it("manual beats loopback beats tap-along beats the estimate; failed and stale are skipped", () => {
    const est = estimateFromReported({ outputLatency: 0.03 });
    expect(chooseLatency([], est)).toBe(est);
    expect(chooseLatency([mk({ method: "tap-along" }), mk({ roundTripMs: 7 })], est).roundTripMs).toBe(7);
    expect(chooseLatency([mk({}), mk({ method: "manual", roundTripMs: 3 })], est).method).toBe("manual");
    expect(chooseLatency([mk({ confidence: "failed" })], est)).toBe(est);
    expect(chooseLatency([mk({ reportedOutputMs: 10 })], est, 40)).toBe(est);
    expect(chooseLatency([mk({ reportedOutputMs: 10 })], est, 14).method).toBe("loopback");
  });

  it("device key changes when the default output's real device changes", () => {
    const pair = (out: string) => ({
      input: { deviceId: "default", label: "Scarlett 2i2" },
      output: { deviceId: "default", label: out },
      sampleRate: 48000,
    });
    expect(devicePairKey(pair("Default - MacBook Pro Speakers"))).not.toBe(devicePairKey(pair("Default - AirPods Pro")));
  });

  it("flags Bluetooth by label or by a large reported output latency", () => {
    expect(assessOutput("Default - AirPods Pro").suitability).toBe("bluetooth");
    expect(assessOutput("WH-1000XM4 (Bluetooth)").suitability).toBe("bluetooth");
    expect(assessOutput("External Headphones", 0.18).suitability).toBe("bluetooth");
    expect(assessOutput("Scarlett 2i2 USB", 0.004).suitability).toBe("ok");
    expect(assessOutput("").suitability).toBe("unknown");
  });

  it("stores per pair, one per method, and survives a throwing storage", () => {
    const mem = new Map<string, string>();
    const kv: KeyValueStore = {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    };
    const store = new LatencyStore(kv);
    store.save("a", mk({ roundTripMs: 1 }));
    store.save("a", mk({ roundTripMs: 2 }));
    store.save("a", mk({ method: "tap-along" }));
    expect(store.get("a").map((r) => r.roundTripMs).sort()).toEqual([2, 20]);
    expect(store.get("b")).toEqual([]);
    const broken = new LatencyStore({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
    });
    broken.save("a", mk({}));
    expect(broken.get("a")).toEqual([]);
  });
});

/**
 * The microphone chain, measured on deterministic audio.
 *
 * Runs the real worklet code (RNNoise and GTCRN from
 * `@sapphi-red/web-noise-suppressor`, and the voice gate) frame by frame in
 * plain Node on the synthetic scene from `src/lib/voice-gate/fixtures.ts`, and
 * prints, per room and per chain:
 *
 *   gap dB    how much quieter the nothing-but-room stretches got (higher is
 *             better), measured against the raw microphone
 *   key dB    the same for the loudest key click in those gaps
 *   onset dB  energy kept in the first 40 ms of a word, against what the stage
 *             before the gate delivered (0 is nothing clipped; "-" means that
 *             window was already silent and the gate had nothing to lose)
 *   word dB   the same over the whole word
 *   lag ms    delay the chain adds (cross-correlated for the suppressors, the
 *             lookahead for the gate)
 *   cpu x     render-thread cost as a multiple of real time, so 0.01 is 1 %
 *             of one core; Node's wasm, not a phone, so only the ratios mean
 *             anything
 *
 *   node bench/voice-gate-bench.mjs
 *
 * Not in CI: it is a measurement, not an assertion. The assertions live in
 * `src/lib/voice-gate/voice-gate.test.ts` and run on the gate alone.
 *
 * What it cannot tell you: the scene's voice is synthetic (a source-filter
 * vowel model), so how RNNoise or GTCRN treats a REAL voice, and above all how
 * it sounds, is a listening test. See `docs/NOISE_SUPPRESSION.md`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createProcessor, runMono } from "./lib/worklet-host.mjs";
import { buildScene } from "../src/lib/voice-gate/fixtures.ts";
import * as M from "../src/lib/voice-gate/metrics.ts";
import { VoiceGate } from "../src/lib/voice-gate/voice-gate-worklet.js";

const SR = 48000;
const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve("@sapphi-red/web-noise-suppressor"));
const bin = (file) => {
  const b = readFileSync(path.join(dist, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const ROOMS = [
  { name: "fan -48, soft keys", options: { fanDb: -48, keyboardPeakDb: -38 } },
  { name: "fan -48, LOUD keys", options: { fanDb: -48, keyboardPeakDb: -28 } },
  { name: "loud room fan -40", options: { fanDb: -40, keyboardPeakDb: -30 } },
];

async function suppressor(kind) {
  if (kind === "rnnoise") {
    return createProcessor(
      path.join(dist, "rnnoise/workletProcessor.js"),
      "@sapphi-red/web-noise-suppressor/rnnoise",
      { maxChannels: 1, wasmBinary: bin("rnnoise_simd.wasm") },
      SR,
    );
  }
  return createProcessor(
    path.join(dist, "gtcrn/workletProcessor.js"),
    "@sapphi-red/web-noise-suppressor/gtcrn",
    { maxChannels: 1, wasmBinary: bin("gtcrn.wasm") },
    SR,
  );
}

/**
 * `sidechain`, when given, is the raw microphone and the gate reads it for its
 * decisions with no lookahead of its own, which is how Voz limpa wires it.
 */
function runGate(signal, sidechain = null) {
  const gate = new VoiceGate({
    sampleRate: SR,
    ...(sidechain ? { lookaheadMs: 0 } : {}),
  });
  const out = new Float32Array(signal.length);
  const frame = new Float32Array(128);
  const side = new Float32Array(128);
  for (let at = 0; at < signal.length; at += 128) {
    const n = Math.min(128, signal.length - at);
    frame.fill(0);
    frame.set(signal.subarray(at, at + n));
    const o = new Float32Array(128);
    if (sidechain) {
      side.fill(0);
      side.set(sidechain.subarray(at, at + n));
      gate.process([frame], [o], [side]);
    } else {
      gate.process([frame], [o]);
    }
    out.set(o.subarray(0, n), at);
  }
  return { out, latency: gate.latencySamples };
}

const fmt = (x, d = 1) => (x === null ? "-" : x.toFixed(d).padStart(6));
const mean = (xs) => {
  const v = xs.filter((x) => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const worst = (xs) => {
  const v = xs.filter((x) => x !== null);
  return v.length ? Math.min(...v) : null;
};

const rows = [];

for (const room of ROOMS) {
  const scene = buildScene(room.options);
  const gaps = M.gapWindows(scene);
  const keys = M.keyboardInGaps(scene, gaps);
  const secs = scene.length / SR;

  const report = (label, aligned, reference, lagMs, cpu) => {
    rows.push({
      room: room.name,
      label,
      gap: M.gapReductionDb(scene.mix, aligned, gaps),
      key: M.keyboardPeakReductionDb(scene.mix, aligned, keys),
      onsetWorst: worst(M.onsetLossDb(scene, reference, aligned)),
      wordMean: mean(M.wordLossDb(scene, reference, aligned)),
      lagMs,
      cpu,
    });
  };

  // Gate straight on the raw microphone.
  {
    const t = performance.now();
    const { out, latency } = runGate(scene.mix);
    const cpu = (performance.now() - t) / 1000 / secs;
    report("gate only", M.align(out, latency), scene.mix, (latency / SR) * 1000, cpu);
  }

  for (const kind of ["rnnoise", "gtcrn"]) {
    const proc = await suppressor(kind);
    const t = performance.now();
    const sOut = runMono(proc, scene.mix);
    const cpu = (performance.now() - t) / 1000 / secs;
    const lag = M.estimateLag(scene.mix, sOut, Math.round(1.2 * SR), Math.round(1.75 * SR), 4000);
    const sAligned = M.align(sOut, lag);
    // The suppressor alone: its onset is judged against the raw microphone.
    report(kind, sAligned, scene.mix, (lag / SR) * 1000, cpu);

    // The gate's onset is judged against the suppressor's own output.
    {
      const t2 = performance.now();
      const { out, latency } = runGate(sOut);
      const gateCpu = (performance.now() - t2) / 1000 / secs;
      report(
        `${kind} + gate*`,
        M.align(out, lag + latency),
        sAligned,
        ((lag + latency) / SR) * 1000,
        cpu + gateCpu,
      );
    }
    {
      const t2 = performance.now();
      const { out, latency } = runGate(sOut, scene.mix);
      const gateCpu = (performance.now() - t2) / 1000 / secs;
      report(
        `${kind} + gate`,
        M.align(out, lag + latency),
        sAligned,
        ((lag + latency) / SR) * 1000,
        cpu + gateCpu,
      );
    }
  }
}

let room = "";
for (const r of rows) {
  if (r.room !== room) {
    room = r.room;
    console.log(`\n${room}`);
    console.log("  chain             gap dB  key dB  onset dB  word dB  lag ms  cpu x");
  }
  console.log(
    `  ${r.label.padEnd(16)} ${fmt(r.gap)} ${fmt(r.key)}  ${fmt(r.onsetWorst)}   ${fmt(r.wordMean)}  ${fmt(r.lagMs)} ${fmt(r.cpu, 4)}`,
  );
}
console.log(
  "\n'+ gate' reads the raw microphone as its sidechain (what Voz limpa ships); '+ gate*' judges the suppressor's own output, for comparison.",
);
console.log(
  "onset dB: worst word. For the suppressor rows it is against the raw mic, for '+ gate' rows against that suppressor's own output.",
);

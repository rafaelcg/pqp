/**
 * What "better" means for the microphone chain, as numbers.
 *
 * Every function takes the fixture `Scene` and the chain's output, aligned for
 * the chain's own latency first (`align`), so a window in the input is the same
 * window in the output.
 *
 *   - gap reduction: how much quieter the stretches of nothing-but-room got,
 *     measured away from the words (a quarter second after one ends, a
 *     fraction before the next starts) because the gate is SUPPOSED to hold
 *     open around a word;
 *   - keyboard peak reduction: the same gaps, but the loudest click in them;
 *   - onset loss: energy in the first 40 ms of each word against what went in.
 *     The number a gate gets wrong first. 0 dB is nothing lost, -3 dB is half
 *     the energy of the consonant gone;
 *   - word loss: the same over the whole word;
 *   - latency: how many samples later the chain's output is than its input,
 *     found by cross-correlation on the speech so it is measured, not assumed.
 */

import { peakDb, rmsDb, type Scene } from "./fixtures.ts";

export interface Window {
  from: number;
  to: number;
}

/** Output shifted back by `lag` samples so it lines up with the input. */
export function align(output: Float32Array, lag: number): Float32Array {
  const out = new Float32Array(output.length);
  out.set(output.subarray(lag));
  return out;
}

/** Stretches with no word in them, kept clear of the words by a margin. */
export function gapWindows(
  scene: Scene,
  { afterWordS = 0.3, beforeWordS = 0.05, minLengthS = 0.2 } = {},
): Window[] {
  const sr = scene.sampleRate;
  const windows: Window[] = [];
  for (let i = 0; i < scene.words.length - 1; i++) {
    const from = Math.round((scene.words[i].end + afterWordS) * sr);
    const to = Math.round((scene.words[i + 1].start - beforeWordS) * sr);
    if ((to - from) / sr >= minLengthS) {
      windows.push({ from, to });
    }
  }
  // The tail after the last word, up to the end of the scene.
  const last = scene.words[scene.words.length - 1];
  const from = Math.round((last.end + afterWordS) * sr);
  if ((scene.length - from) / sr >= minLengthS) {
    windows.push({ from, to: scene.length });
  }
  return windows;
}

/** The parts of the keyboard bursts that fall inside a gap window. */
export function keyboardInGaps(scene: Scene, gaps: Window[]): Window[] {
  const sr = scene.sampleRate;
  const out: Window[] = [];
  for (const [bs, be] of scene.keyboardBursts) {
    const b0 = Math.round(bs * sr);
    const b1 = Math.round(be * sr);
    for (const g of gaps) {
      const from = Math.max(b0, g.from);
      const to = Math.min(b1, g.to);
      if (to - from > 0.05 * sr) {
        out.push({ from, to });
      }
    }
  }
  return out;
}

function energy(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = Math.max(0, from); i < Math.min(buf.length, to); i++) {
    sum += buf[i] * buf[i];
  }
  return sum;
}

const db10 = (ratio: number): number => 10 * Math.log10(ratio + 1e-20);

/** Mean level drop over the gaps, in dB (positive is quieter). */
export function gapReductionDb(input: Float32Array, aligned: Float32Array, gaps: Window[]): number {
  let inE = 0;
  let outE = 0;
  let n = 0;
  for (const g of gaps) {
    inE += energy(input, g.from, g.to);
    outE += energy(aligned, g.from, g.to);
    n += g.to - g.from;
  }
  return db10(inE / n) - db10(outE / n);
}

/** Loudest click in the keyboard-in-gap windows, input minus output, in dB. */
export function keyboardPeakReductionDb(input: Float32Array, aligned: Float32Array, windows: Window[]): number {
  let inPeak = -200;
  let outPeak = -200;
  for (const w of windows) {
    inPeak = Math.max(inPeak, peakDb(input, w.from, w.to));
    outPeak = Math.max(outPeak, peakDb(aligned, w.from, w.to));
  }
  return inPeak - outPeak;
}

/**
 * Output energy over input energy in the first `ms` of each word, in dB, or
 * `null` where the input itself had nothing audible there (a fricative the
 * suppressor already removed): a gate cannot lose what was not sent to it.
 */
export function onsetLossDb(
  scene: Scene,
  input: Float32Array,
  aligned: Float32Array,
  { ms = 40, minInputDb = -55 } = {},
): (number | null)[] {
  const sr = scene.sampleRate;
  return scene.words.map((w) => {
    const from = Math.round(w.start * sr);
    const to = from + Math.round((ms * sr) / 1000);
    if (rmsDb(input, from, to) < minInputDb) {
      return null;
    }
    return db10(energy(aligned, from, to) / (energy(input, from, to) + 1e-20));
  });
}

/** The same over the whole word. */
export function wordLossDb(scene: Scene, input: Float32Array, aligned: Float32Array): number[] {
  const sr = scene.sampleRate;
  return scene.words.map((w) => {
    const from = Math.round(w.start * sr);
    const to = Math.round(w.end * sr);
    return db10(energy(aligned, from, to) / (energy(input, from, to) + 1e-20));
  });
}

/**
 * Samples of delay between `input` and `output`, by cross-correlation over
 * `[from, to)`: the lag in `0..maxLag` where the two agree best.
 */
export function estimateLag(input: Float32Array, output: Float32Array, from: number, to: number, maxLag: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = from; i < to; i++) {
      score += input[i] * output[i + lag];
    }
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  return best;
}

export { rmsDb };

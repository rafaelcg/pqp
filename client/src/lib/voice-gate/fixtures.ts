/**
 * Deterministic audio for measuring the microphone chain, generated in code.
 *
 * Nothing here is a recording, so there is no licence to carry and no binary in
 * the repository: the same seed yields the same samples on every machine, which
 * is what lets a threshold in a test mean something. Written without imports
 * or any TypeScript that needs a compiler pass beyond type stripping, so the
 * vitest suite and `client/bench/voice-gate-bench.mjs` share the one file.
 *
 * The scene is fourteen seconds at 48 kHz:
 *
 *   - SPEECH: six "words" built as source-filter vowels (a glottal pulse train
 *     with a wandering pitch, through five formant resonators, with a little
 *     aspiration noise), some with a leading fricative ("s"), at -22 dBFS RMS
 *     over the words. Synthetic, so it is not a claim about how a real voice
 *     sounds through RNNoise (see the caveats in `docs/NOISE_SUPPRESSION.md`);
 *     it is a signal with the properties a gate must respect: a soft onset, a
 *     short word, a fricative that starts a word, and vowels that dip between
 *     syllables.
 *   - FAN: stationary low-heavy noise at -48 dBFS RMS with a 100 Hz hum.
 *   - KEYBOARD: bursts of clicks (a 2 to 6 kHz ring with a ~1.5 ms decay and a
 *     low thump) in the gaps between words, peaking around -38 dBFS (`keyboardPeakDb` raises it).
 *
 * `speech`, `fan` and `keyboard` are kept separate beside the `mix` so a
 * metric can ask what the chain did to each.
 */

export const FIXTURE_SAMPLE_RATE = 48000;

export interface FixtureWord {
  /** Seconds. `start` includes the fricative when there is one. */
  start: number;
  end: number;
  fricativeMs: number;
  vowels: string[];
}

export interface Scene {
  sampleRate: number;
  length: number;
  words: FixtureWord[];
  /** Seconds, [start, end] of each stretch of keyboard clicks. */
  keyboardBursts: [number, number][];
  speech: Float32Array;
  fan: Float32Array;
  keyboard: Float32Array;
  mix: Float32Array;
}

export interface SceneOptions {
  seed?: number;
  fanDb?: number;
  speechDb?: number;
  /** Peak level of a click. */
  keyboardPeakDb?: number;
  seconds?: number;
}

/** mulberry32: small, fast and identical everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dbToAmp = (db: number): number => Math.pow(10, db / 20);

export function rms(buf: Float32Array, from = 0, to = buf.length): number {
  const a = Math.max(0, from);
  const b = Math.min(buf.length, to);
  let sum = 0;
  for (let i = a; i < b; i++) {
    sum += buf[i] * buf[i];
  }
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
}

export function rmsDb(buf: Float32Array, from = 0, to = buf.length): number {
  return 20 * Math.log10(rms(buf, from, to) + 1e-9);
}

export function peakDb(buf: Float32Array, from = 0, to = buf.length): number {
  let peak = 0;
  const a = Math.max(0, from);
  const b = Math.min(buf.length, to);
  for (let i = a; i < b; i++) {
    peak = Math.max(peak, Math.abs(buf[i]));
  }
  return 20 * Math.log10(peak + 1e-9);
}

/** The classic five-formant vowel table (F1..F3 measured, F4 and F5 fixed). */
const VOWELS: Record<string, [number, number, number]> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240],
};
const BANDWIDTHS = [70, 90, 130, 250, 300];

class Resonator {
  private a = 0;
  private b = 0;
  private c = 0;
  private y1 = 0;
  private y2 = 0;

  set(freq: number, bw: number, sampleRate: number): void {
    const r = Math.exp((-Math.PI * bw) / sampleRate);
    this.c = -(r * r);
    this.b = 2 * r * Math.cos((2 * Math.PI * freq) / sampleRate);
    this.a = 1 - this.b - this.c;
  }

  next(x: number): number {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** One voiced word: vowels glided between, pitch wandering, soft envelope. */
function voicedWord(
  out: Float32Array,
  startSample: number,
  vowels: string[],
  fricativeMs: number,
  sampleRate: number,
  rand: () => number,
): number {
  const syllableSamples = Math.round(0.17 * sampleRate);
  const fricativeSamples = Math.round((fricativeMs * sampleRate) / 1000);
  const total = fricativeSamples + vowels.length * syllableSamples;
  const res = [0, 1, 2, 3, 4].map(() => new Resonator());
  let phase = 0;
  let f0 = 118 + rand() * 24;
  let hp = 0;
  let prevNoise = 0;

  for (let n = 0; n < total; n++) {
    const at = startSample + n;
    if (at >= out.length) {
      break;
    }
    if (n < fricativeSamples) {
      // "s": high-passed noise, ramped, well below the vowel that follows.
      const white = rand() * 2 - 1;
      hp = white - prevNoise;
      prevNoise = white;
      const ramp = Math.min(1, n / (0.012 * sampleRate));
      const fade = n > fricativeSamples - 0.01 * sampleRate
        ? (fricativeSamples - n) / (0.01 * sampleRate)
        : 1;
      out[at] += hp * 0.45 * ramp * Math.max(0, fade);
      continue;
    }
    const m = n - fricativeSamples;
    const syllable = Math.min(vowels.length - 1, Math.floor(m / syllableSamples));
    const within = (m - syllable * syllableSamples) / syllableSamples;
    const target = VOWELS[vowels[syllable]];
    const next = VOWELS[vowels[Math.min(vowels.length - 1, syllable + 1)]];
    // Glide to the next vowel over the last 25 % of a syllable.
    const glide = within > 0.75 ? (within - 0.75) / 0.25 : 0;
    for (let k = 0; k < 5; k++) {
      const freq =
        k < 3
          ? target[k] + (next[k] - target[k]) * glide
          : 3300 + (k - 3) * 1000;
      res[k].set(freq, BANDWIDTHS[k], sampleRate);
    }
    // Pitch: slow drift plus vibrato-ish wobble, never constant.
    f0 += (rand() - 0.5) * 0.05;
    const inst = f0 * (1 + 0.012 * Math.sin((2 * Math.PI * 5.2 * n) / sampleRate));
    phase += inst / sampleRate;
    if (phase >= 1) {
      phase -= 1;
    }
    // A Rosenberg-like glottal pulse: smooth open phase, sharp close.
    const open = 0.6;
    const pulse =
      phase < open
        ? 0.5 * (1 - Math.cos((Math.PI * phase) / open))
        : Math.cos((Math.PI * (phase - open)) / (2 * (1 - open)));
    const source = pulse - 0.3 + (rand() - 0.5) * 0.06;
    let y = 0;
    for (let k = 0; k < 5; k++) {
      y += res[k].next(source) * (k === 0 ? 1 : k === 1 ? 0.7 : 0.35);
    }
    // Envelope: 25 ms onset, 70 % dip between syllables, 60 ms tail.
    const wordPos = m;
    const wordLen = vowels.length * syllableSamples;
    const onset = Math.min(1, wordPos / (0.025 * sampleRate));
    const tail = Math.min(1, (wordLen - wordPos) / (0.06 * sampleRate));
    const dip = 0.7 + 0.3 * Math.sin(Math.PI * Math.min(1, within));
    out[at] += y * onset * tail * dip;
  }
  return total;
}

/** Stationary fan: low-heavy noise plus a 100 Hz hum, at `db` dBFS RMS. */
function fanNoise(length: number, sampleRate: number, db: number, rand: () => number): Float32Array {
  const out = new Float32Array(length);
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < length; i++) {
    const white = rand() * 2 - 1;
    lp1 += 0.02 * (white - lp1);
    lp2 += 0.12 * (white - lp2);
    out[i] =
      lp1 * 2.2 +
      lp2 * 1.0 +
      white * 0.25 +
      0.25 * Math.sin((2 * Math.PI * 100 * i) / sampleRate);
  }
  const gain = dbToAmp(db) / (rms(out) + 1e-12);
  for (let i = 0; i < length; i++) {
    out[i] *= gain;
  }
  return out;
}

/** A single key click: a 2 to 6 kHz ring and a low thump, decaying in ~8 ms. */
function addClick(out: Float32Array, at: number, amp: number, sampleRate: number, rand: () => number): void {
  const freq = 2000 + rand() * 4000;
  const tau = (1.0 + rand() * 1.0) / 1000;
  const length = Math.round(0.012 * sampleRate);
  for (let n = 0; n < length && at + n < out.length; n++) {
    const t = n / sampleRate;
    const env = Math.exp(-t / tau);
    out[at + n] +=
      amp * env * Math.sin(2 * Math.PI * freq * t) +
      0.4 * amp * Math.exp(-t / (4 * tau)) * Math.sin(2 * Math.PI * 300 * t);
  }
}

export const DEFAULT_WORDS: Omit<FixtureWord, "end">[] = [
  { start: 1.2, fricativeMs: 0, vowels: ["a", "e"] },
  { start: 2.6, fricativeMs: 80, vowels: ["i", "a"] },
  { start: 4.95, fricativeMs: 0, vowels: ["o"] },
  { start: 6.4, fricativeMs: 0, vowels: ["u", "e", "a"] },
  { start: 9.0, fricativeMs: 80, vowels: ["a"] },
  { start: 10.4, fricativeMs: 0, vowels: ["i", "o"] },
];

export const DEFAULT_KEYBOARD_BURSTS: [number, number][] = [
  [0.25, 0.9],
  [3.7, 4.5],
  [7.5, 8.7],
  [11.8, 13.2],
];

export function buildScene(options: SceneOptions = {}): Scene {
  const sampleRate = FIXTURE_SAMPLE_RATE;
  const seconds = options.seconds ?? 14;
  const length = Math.round(seconds * sampleRate);
  const rand = rng(options.seed ?? 20261105);

  const speech = new Float32Array(length);
  const words: FixtureWord[] = [];
  for (const w of DEFAULT_WORDS) {
    // A shorter scene keeps only the words that fit in it.
    const duration = w.fricativeMs / 1000 + w.vowels.length * 0.17;
    if (w.start + duration > seconds) {
      continue;
    }
    const samples = voicedWord(
      speech,
      Math.round(w.start * sampleRate),
      w.vowels,
      w.fricativeMs,
      sampleRate,
      rand,
    );
    words.push({ ...w, end: w.start + samples / sampleRate });
  }
  // Level the speech so the words themselves sit at `speechDb` RMS.
  let sumSq = 0;
  let count = 0;
  for (const w of words) {
    const a = Math.round(w.start * sampleRate);
    const b = Math.round(w.end * sampleRate);
    for (let i = a; i < b; i++) {
      sumSq += speech[i] * speech[i];
      count += 1;
    }
  }
  const speechGain = dbToAmp(options.speechDb ?? -22) / Math.sqrt(sumSq / count);
  for (let i = 0; i < length; i++) {
    speech[i] *= speechGain;
  }

  const fan = fanNoise(length, sampleRate, options.fanDb ?? -48, rand);

  const keyboard = new Float32Array(length);
  const clickAmp = dbToAmp(options.keyboardPeakDb ?? -38);
  for (const [from, to] of DEFAULT_KEYBOARD_BURSTS) {
    let t = from;
    while (t < to) {
      addClick(
        keyboard,
        Math.round(t * sampleRate),
        clickAmp * (0.5 + 0.5 * rand()),
        sampleRate,
        rand,
      );
      t += 0.07 + rand() * 0.09;
    }
  }

  const mix = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    mix[i] = speech[i] + fan[i] + keyboard[i];
  }
  return {
    sampleRate,
    length,
    words,
    keyboardBursts: DEFAULT_KEYBOARD_BURSTS,
    speech,
    fan,
    keyboard,
    mix,
  };
}

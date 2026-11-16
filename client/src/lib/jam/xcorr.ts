/**
 * Finding a known sound in a recording, and finding where two recordings of
 * the same sound line up. Pure functions, no DOM; the calibration, the video
 * alignment and the tests all go through here.
 */

export interface PulseMatch {
  /**
   * Where `ref` starts in `signal`, in samples, with a sub-sample part from a
   * parabola through the peak and its two neighbours.
   */
  position: number;
  /** Normalised correlation at the peak, 0..1 (absolute: polarity is ignored). */
  quality: number;
}

/**
 * Normalised cross-correlation of `ref` against `signal`, for every start
 * position in `[from, to]`, and the position of the DIRECT sound.
 *
 * "Direct" matters in a room: a wall a metre away gives a second copy of the
 * click about 6 ms later, sometimes louder than the first at the microphone.
 * So the answer is the EARLIEST local peak that reaches `earliestRatio` of the
 * strongest one, not simply the strongest. Polarity is ignored (`abs`)
 * because plenty of microphones and interfaces invert.
 */
export function findPulse(
  signal: Float32Array,
  ref: Float32Array,
  from: number,
  to: number,
  options: { earliestRatio?: number; sampleRate?: number } = {},
): PulseMatch | null {
  const earliestRatio = options.earliestRatio ?? 0.6;
  const sampleRate = options.sampleRate ?? 48000;
  const n = ref.length;
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(signal.length - n, Math.floor(to));
  if (end < start) return null;
  let refEnergy = 0;
  for (let i = 0; i < n; i++) refEnergy += ref[i] * ref[i];
  if (refEnergy === 0) return null;
  const refNorm = Math.sqrt(refEnergy);

  const count = end - start + 1;
  const ncc = new Float32Array(count);
  // sliding energy of the signal window
  let winEnergy = 0;
  for (let i = 0; i < n; i++) winEnergy += signal[start + i] * signal[start + i];
  let best = 0;
  for (let k = 0; k < count; k++) {
    const p = start + k;
    if (k > 0) {
      const out = signal[p - 1];
      const inn = signal[p + n - 1];
      winEnergy += inn * inn - out * out;
      if (winEnergy < 0) winEnergy = 0;
    }
    let dot = 0;
    for (let i = 0; i < n; i++) dot += ref[i] * signal[p + i];
    const denom = refNorm * Math.sqrt(winEnergy);
    const v = denom > 1e-12 ? Math.abs(dot) / denom : 0;
    ncc[k] = v;
    if (v > best) best = v;
  }
  if (best <= 0) return null;
  // A correlation peak of a band-limited pulse rings: with polarity ignored,
  // its first sidelobes are a fraction of a millisecond away and can reach
  // most of the main peak. So a candidate must be the largest value within
  // `guard` either side of it. A real reflection arrives later than that
  // (half a millisecond is 17 cm of extra path).
  const guard = Math.max(2, Math.round(sampleRate * 0.0005));
  const threshold = best * earliestRatio;
  let peak = -1;
  for (let k = 0; k < count; k++) {
    const v = ncc[k];
    if (v < threshold) continue;
    let isMax = true;
    for (let j = Math.max(0, k - guard); j <= Math.min(count - 1, k + guard); j++) {
      if (ncc[j] > v) {
        isMax = false;
        break;
      }
    }
    if (isMax) {
      peak = k;
      break;
    }
  }
  if (peak < 0) return null;
  const frac =
    peak > 0 && peak < count - 1 ? parabolicOffset(ncc[peak - 1], ncc[peak], ncc[peak + 1]) : 0;
  return { position: start + peak + frac, quality: ncc[peak] };
}

/**
 * Vertex of the parabola through three equally spaced points, as an offset
 * from the middle one, in -0.5..0.5.
 */
export function parabolicOffset(left: number, mid: number, right: number): number {
  const denom = left - 2 * mid + right;
  if (denom === 0) return 0;
  const off = (0.5 * (left - right)) / denom;
  return Math.max(-0.5, Math.min(0.5, off));
}

/** In-place iterative radix-2 FFT. `re` and `im` have a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Where `needle` sits inside `haystack`, by FFT cross-correlation: returns the
 * index in `haystack` where `needle[0]` lines up best, searched over every
 * start in `[0, haystack.length - needle.length]`, plus a quality (peak over
 * the geometric mean of the two energies, 0..1).
 *
 * Used to line a camera file's own audio up against the PCM take; whole
 * samples are plenty for a picture whose frames are 33 ms apart.
 */
export function locate(
  haystack: Float32Array,
  needle: Float32Array,
  options: { prefer?: number; nearRatio?: number } = {},
): PulseMatch | null {
  const span = haystack.length - needle.length;
  if (span < 0 || needle.length === 0) return null;
  let size = 1;
  while (size < haystack.length + needle.length) size <<= 1;
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  for (let i = 0; i < haystack.length; i++) ar[i] = haystack[i];
  for (let i = 0; i < needle.length; i++) br[i] = needle[i];
  fft(ar, ai);
  fft(br, bi);
  // A * conj(B)
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  let needleEnergy = 0;
  for (let i = 0; i < needle.length; i++) needleEnergy += needle[i] * needle[i];
  // prefix energy of the haystack for per-lag normalisation
  const prefix = new Float64Array(haystack.length + 1);
  for (let i = 0; i < haystack.length; i++) prefix[i + 1] = prefix[i] + haystack[i] * haystack[i];
  const ncc = new Float32Array(span + 1);
  let bestLag = -1;
  let best = 0;
  for (let lag = 0; lag <= span; lag++) {
    const e = prefix[lag + needle.length] - prefix[lag];
    const d = Math.sqrt(e * needleEnergy);
    const v = d > 1e-12 ? Math.abs(ar[lag]) / d : 0;
    ncc[lag] = v;
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  // Repetitive material (a looped riff, a click) matches at several lags
  // almost equally; then the one nearest the caller's prior guess wins.
  if (options.prefer !== undefined && bestLag >= 0) {
    const floor = best * (options.nearRatio ?? 0.9);
    let pick = bestLag;
    for (let lag = 0; lag <= span; lag++) {
      if (ncc[lag] < floor) continue;
      if (lag > 0 && ncc[lag - 1] > ncc[lag]) continue;
      if (lag < span && ncc[lag + 1] > ncc[lag]) continue;
      if (Math.abs(lag - options.prefer) < Math.abs(pick - options.prefer)) pick = lag;
    }
    return { position: pick, quality: ncc[pick] };
  }
  if (bestLag < 0) return null;
  return { position: bestLag, quality: best };
}

/**
 * Onsets in a recording: claps, a tapped microphone, a muted string hit. A
 * first-difference (so rumble and DC do not count) is rectified and
 * averaged over 1 ms; an onset is where that envelope crosses `thresholdRatio`
 * of the loudest hit in the window and has been quiet for `refractoryMs`
 * before. The returned position is the first SAMPLE in that millisecond that
 * reaches a third of the local peak, so it is sharper than the 1 ms grid.
 */
export function detectOnsets(
  signal: Float32Array,
  sampleRate: number,
  options: { thresholdRatio?: number; refractoryMs?: number } = {},
): number[] {
  const thresholdRatio = options.thresholdRatio ?? 0.3;
  const refractory = Math.round(((options.refractoryMs ?? 120) / 1000) * sampleRate);
  const hop = Math.max(1, Math.round(sampleRate / 1000));
  const frames = Math.floor((signal.length - 1) / hop);
  if (frames <= 0) return [];
  const env = new Float32Array(frames);
  let max = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const base = f * hop + 1;
    for (let i = 0; i < hop; i++) s += Math.abs(signal[base + i] - signal[base + i - 1]);
    env[f] = s / hop;
    if (env[f] > max) max = env[f];
  }
  if (max === 0) return [];
  const threshold = max * thresholdRatio;
  const out: number[] = [];
  let lastOnset = -Infinity;
  for (let f = 0; f < frames; f++) {
    if (env[f] < threshold) continue;
    const at = f * hop;
    if (at - lastOnset < refractory) continue;
    // local peak of |x| over the next 5 ms, then the first sample in this
    // frame's neighbourhood reaching a third of it
    let localPeak = 0;
    const peakEnd = Math.min(signal.length, at + Math.round(0.005 * sampleRate));
    for (let i = Math.max(0, at - hop); i < peakEnd; i++) {
      const a = Math.abs(signal[i]);
      if (a > localPeak) localPeak = a;
    }
    let onset = at;
    for (let i = Math.max(0, at - hop); i < peakEnd; i++) {
      if (Math.abs(signal[i]) >= localPeak / 3) {
        onset = i;
        break;
      }
    }
    out.push(onset);
    lastOnset = at;
  }
  return out;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

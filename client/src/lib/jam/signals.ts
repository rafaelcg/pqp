/**
 * Test and calibration signals, as plain Float32Arrays.
 *
 * No imports and no DOM on purpose: the Playwright spec imports this file in
 * Node to write the fake microphone file, so the signal the browser captures
 * and the reference the engine correlates against come from the same code.
 */

/**
 * A Hann-windowed exponential sweep. Its autocorrelation is one sharp peak a
 * sample wide, which is what makes it a good thing to find in a recording: a
 * laptop speaker and a laptop microphone colour it, they do not move its peak.
 *
 * `direction: "down"` (8 kHz to 1 kHz) is the loopback calibration signal;
 * `"up"` is used by the tests as a backing click that the calibration
 * reference must NOT match (an up and a down sweep barely correlate).
 */
export function sweep(
  sampleRate: number,
  options: { durationMs?: number; direction?: "up" | "down"; amplitude?: number } = {},
): Float32Array {
  const durationMs = options.durationMs ?? 10;
  const amplitude = options.amplitude ?? 0.5;
  const n = Math.max(16, Math.round((durationMs / 1000) * sampleRate));
  // Stay clear of Nyquist on a 16 kHz Bluetooth headset microphone.
  const high = Math.min(8000, sampleRate * 0.4);
  const low = Math.min(1000, high / 4);
  const [f0, f1] = options.direction === "up" ? [low, high] : [high, low];
  const out = new Float32Array(n);
  const T = n / sampleRate;
  const k = Math.log(f1 / f0);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // phase of an exponential sweep: 2*pi*f0*T/k*(e^(t*k/T) - 1)
    const phase = ((2 * Math.PI * f0 * T) / k) * (Math.exp((t * k) / T) - 1);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = amplitude * w * Math.sin(phase);
  }
  return out;
}

/**
 * A metronome click: a short decaying sine. `accent` is the first beat of a
 * bar (higher and louder), the way every DAW's click sounds.
 */
export function metronomeClick(sampleRate: number, accent = false): Float32Array {
  const freq = accent ? 1760 : 1320;
  const n = Math.round(0.03 * sampleRate);
  const out = new Float32Array(n);
  const amp = accent ? 0.6 : 0.4;
  const attack = Math.round(0.001 * sampleRate);
  for (let i = 0; i < n; i++) {
    const env = i < attack ? i / attack : Math.exp(-(i - attack) / (0.006 * sampleRate));
    out[i] = amp * env * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

/** Lay `pulse` into a silent buffer at each frame in `at` (mono). */
export function pulseTrain(lengthFrames: number, pulse: Float32Array, at: number[]): Float32Array {
  const out = new Float32Array(lengthFrames);
  for (const start of at) {
    for (let i = 0; i < pulse.length; i++) {
      const j = start + i;
      if (j >= 0 && j < lengthFrames) out[j] += pulse[i];
    }
  }
  return out;
}

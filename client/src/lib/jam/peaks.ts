/**
 * A waveform you can draw without the audio: at most `count` numbers in 0..1,
 * each the loudest absolute sample (any channel) in its slice of the WHOLE
 * buffer, trims included, so the UI draws the trimmed part greyed out and a
 * trim change needs no new peaks.
 *
 * Absolute, not normalised: a quiet stem looks quiet next to a loud one. A
 * UI that wants every lane full can divide by the max itself. Rounded to
 * three decimals so the JSON stays small (400 numbers is about 2.4 kB).
 */
export const MAX_PEAKS = 400;

export function computePeaks(channels: ReadonlyArray<Float32Array>, count = MAX_PEAKS): number[] {
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const buckets = Math.max(0, Math.min(Math.floor(count), MAX_PEAKS, length));
  const out = new Array<number>(buckets).fill(0);
  if (buckets === 0) return out;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * length) / buckets);
    const end = Math.floor(((b + 1) * length) / buckets);
    let peak = 0;
    for (const ch of channels) {
      const stop = Math.min(end, ch.length);
      for (let i = start; i < stop; i++) {
        const a = ch[i] < 0 ? -ch[i] : ch[i];
        if (a > peak) peak = a;
      }
    }
    out[b] = Math.round(Math.min(1, peak) * 1000) / 1000;
  }
  return out;
}

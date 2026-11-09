/**
 * Turning the capture worklet's stamped chunks into one contiguous take, and
 * a take's channels into the mono stem it becomes.
 */

export interface StampedChunk {
  frame: number;
  channels: Float32Array[];
}

export interface Assembled {
  /** Context frame of channels[c][0]. */
  startFrame: number;
  channels: Float32Array[];
  /** Frames that were missing between chunks and filled with silence (should be 0). */
  gapFrames: number;
}

/**
 * Lay the chunks out by their stamps. The worklet never skips a quantum, so
 * gaps should not happen; if one does (a message lost to a crashed worklet),
 * it is filled with silence rather than closed up, because closing it would
 * shift everything after it off the song's grid.
 */
export function assembleChunks(chunks: ReadonlyArray<StampedChunk>): Assembled | null {
  if (chunks.length === 0) return null;
  const sorted = [...chunks].sort((a, b) => a.frame - b.frame);
  const startFrame = sorted[0].frame;
  const nch = sorted.reduce((m, c) => Math.max(m, c.channels.length), 1);
  const last = sorted[sorted.length - 1];
  const total = last.frame + (last.channels[0]?.length ?? 0) - startFrame;
  const channels = Array.from({ length: nch }, () => new Float32Array(total));
  let covered = 0;
  let expected = startFrame;
  for (const chunk of sorted) {
    const at = chunk.frame - startFrame;
    const len = chunk.channels[0]?.length ?? 0;
    for (let c = 0; c < nch; c++) {
      const src = chunk.channels[Math.min(c, chunk.channels.length - 1)];
      if (src) channels[c].set(src.subarray(0, Math.min(len, total - at)), at);
    }
    if (chunk.frame > expected) covered += chunk.frame - expected;
    expected = Math.max(expected, chunk.frame + len);
  }
  return { startFrame, channels, gapFrames: covered };
}

export type MonoChoice = "mono" | "left" | "right" | "mix";

/**
 * A stem is mono. A two-input interface usually delivers the guitar on one
 * side and nothing (or a faint bleed) on the other; averaging would cost
 * 6 dB and add the other input's hiss. So: if one side is more than 24 dB
 * quieter, keep the loud side alone; otherwise average the two.
 */
export function chooseMono(channels: ReadonlyArray<Float32Array>): { samples: Float32Array; choice: MonoChoice } {
  if (channels.length === 1) return { samples: channels[0], choice: "mono" };
  const [l, r] = channels;
  const rms = (x: Float32Array) => {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, x.length));
  };
  const a = rms(l);
  const b = rms(r);
  const ratio = 10 ** (24 / 20);
  if (a > b * ratio || (b === 0 && a > 0)) return { samples: l, choice: "left" };
  if (b > a * ratio || (a === 0 && b > 0)) return { samples: r, choice: "right" };
  const out = new Float32Array(l.length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (l[i] + r[i]);
  return { samples: out, choice: "mix" };
}

/**
 * Drop `n` leading frames (n > 0) or prepend -n frames of silence (n < 0).
 * Used to line the take up with the camera file and to land the offset on a
 * whole millisecond.
 */
export function shiftStart(samples: Float32Array, n: number): Float32Array {
  if (n === 0) return samples;
  if (n > 0) return samples.slice(Math.min(n, samples.length));
  const out = new Float32Array(samples.length - n);
  out.set(samples, -n);
  return out;
}

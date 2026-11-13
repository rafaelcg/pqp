/**
 * Whether a take picked up nothing at all, so a person can be told before they
 * send a minute of silence to the band.
 *
 * THE THRESHOLD IS DELIBERATELY LOW. A peak under 0.01 (about -40 dBFS) over the
 * whole part that would be heard is a flat line: a muted or unplugged input, a
 * dead channel of an interface. Quiet playing is nowhere near it (a fingerpicked
 * nylon string through an interface still peaks well above -30 dBFS, and a
 * microphone's own noise floor on a live input does not stay under it for a
 * whole take), so nothing that is merely soft is flagged. The count-in and any
 * trimmed head or tail are not measured: the clicks leak into a microphone and
 * would make a silent take look alive. The take's edited volume counts: a take
 * turned all the way down, or down to under the threshold, is silent as it would
 * be heard.
 *
 * ONE PASS OVER THE SAMPLES, THEN CHEAP. A take near the ten-minute ceiling has
 * tens of millions of samples, and the editor changes trims and volume many times
 * a second, so the samples are reduced once to the loudest value of each 50 ms
 * (`blockPeaks`) and every later question (`silentIn`) reads those few thousand
 * numbers. A block that straddles a trim counts whole, which can only make a
 * take look less silent, never flag one that is not.
 */
export const SILENT_PEAK = 0.01;
/** The length each value of `blockPeaks` covers. */
export const SILENT_BLOCK_MS = 50;

/** The loudest absolute sample between two times in a take, stopping early past `ceiling`. */
export function takePeak(
  samples: Float32Array,
  sampleRate: number,
  fromMs: number,
  toMs: number,
  ceiling = Number.POSITIVE_INFINITY,
): number {
  const from = Math.max(0, Math.floor((fromMs / 1000) * sampleRate));
  const to = Math.min(samples.length, Math.ceil((toMs / 1000) * sampleRate));
  let peak = 0;
  for (let index = from; index < to; index += 1) {
    const value = Math.abs(samples[index]!);
    if (value > peak) {
      peak = value;
      if (peak >= ceiling) {
        return peak;
      }
    }
  }
  return peak;
}

/** The loudest absolute sample of each `blockMs` of the take, in order. One pass. */
export function blockPeaks(samples: Float32Array, sampleRate: number, blockMs = SILENT_BLOCK_MS): Float32Array {
  const size = Math.max(1, Math.round((blockMs / 1000) * sampleRate));
  const out = new Float32Array(Math.ceil(samples.length / size));
  for (let block = 0; block < out.length; block += 1) {
    const end = Math.min(samples.length, (block + 1) * size);
    let peak = 0;
    for (let index = block * size; index < end; index += 1) {
      const value = Math.abs(samples[index]!);
      if (value > peak) {
        peak = value;
      }
    }
    out[block] = peak;
  }
  return out;
}

/**
 * The played part (`fromMs` to `toMs`), at this volume (`gain`, 1 as recorded),
 * never rises above a flat line. `blocks` are `blockPeaks` of the take.
 */
export function silentIn(
  blocks: Float32Array,
  range: { fromMs: number; toMs: number },
  gain = 1,
  blockMs = SILENT_BLOCK_MS,
): boolean {
  if (range.toMs <= range.fromMs || gain <= 0) {
    return true;
  }
  const first = Math.max(0, Math.floor(range.fromMs / blockMs));
  const last = Math.min(blocks.length, Math.ceil(range.toMs / blockMs));
  let peak = 0;
  for (let block = first; block < last; block += 1) {
    if (blocks[block]! > peak) {
      peak = blocks[block]!;
    }
  }
  return peak * gain < SILENT_PEAK;
}

/** The same question straight from the samples (one pass over the played part), for a take that is asked about once. */
export function isSilentTake(
  take: { samples: Float32Array; sampleRate: number; durationMs: number },
  trim: { trimStartMs: number; trimEndMs: number },
): boolean {
  const toMs = take.durationMs - trim.trimEndMs;
  if (toMs <= trim.trimStartMs) {
    return true;
  }
  return takePeak(take.samples, take.sampleRate, trim.trimStartMs, toMs, SILENT_PEAK) < SILENT_PEAK;
}

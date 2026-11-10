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
 * would make a silent take look alive.
 */
export const SILENT_PEAK = 0.01;

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

/** The played part of the take (`trimStartMs` to the end minus `trimEndMs`) never rises above a flat line. */
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

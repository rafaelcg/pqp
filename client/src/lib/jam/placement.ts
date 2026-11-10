/**
 * Where a recorded take lands on the song. Pure arithmetic: this is the
 * formula the whole feature exists for, so it lives alone and is tested
 * alone.
 *
 * THE LATENCY MODEL. One AudioContext plays the backing and runs the capture
 * worklet, so both are stamped in the same unit: context sample frames.
 *
 *   - The backing's song time S leaves the graph at frame F0 + (S - from)·sr.
 *   - The player hears it L_out frames later (base + output latency: the
 *     context's buffer, the OS mixer, the DAC, Bluetooth if any).
 *   - They play along with what they hear. Their note reaches the capture
 *     worklet L_in frames after it was played (ADC, OS, the browser's input
 *     FIFO).
 *   - So the worklet stamps the note for song time S at
 *         F0 + (S - from)·sr + L_out + L_in.
 *
 * Only the SUM, the round trip L = L_out + L_in, matters, and it is exactly
 * what a loopback measures (a click scheduled at frame P comes back stamped
 * P + L). The take's first captured sample, stamped Fc0, therefore belongs
 * at song time
 *
 *         from + (Fc0 - F0 - L) / sr.
 */

export interface TakeClock {
  sampleRate: number;
  /** Song time (ms) the backing started from. */
  fromMs: number;
  /** Context frame at which `fromMs` left the graph. */
  backingStartFrame: number;
  /** Context frame of the first captured sample. */
  captureStartFrame: number;
  /** Round-trip latency compensation, ms (output + input). */
  roundTripMs: number;
}

/** Song time (ms, unrounded) of the take's first captured sample. */
export function takeOffsetMs(c: TakeClock): number {
  return (
    c.fromMs +
    ((c.captureStartFrame - c.backingStartFrame) / c.sampleRate) * 1000 -
    c.roundTripMs
  );
}

/**
 * Make the offset a whole number of milliseconds by dropping a few leading
 * samples (fewer than one millisecond's worth). The server may store
 * `offset_ms` as an integer; this way rounding it moves nothing. At 48 kHz
 * the result is exact; at 44.1 kHz the leftover is under one sample (23 µs).
 */
export function wholeMillisecondOffset(
  offsetMs: number,
  sampleRate: number,
): { offsetMs: number; dropFrames: number } {
  const target = Math.ceil(offsetMs - 1e-9);
  const dropFrames = Math.round(((target - offsetMs) / 1000) * sampleRate);
  return { offsetMs: target, dropFrames };
}

/**
 * Song time of buffer sample `i` for a stem placed at `offsetMs`. The tests
 * and the end-to-end spec use it to say where a detected click sits.
 */
export function sampleToSongMs(i: number, offsetMs: number, sampleRate: number): number {
  return offsetMs + (i / sampleRate) * 1000;
}

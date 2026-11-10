/**
 * The waveform that grows while a take is recorded.
 *
 * The meter hands the studio one peak every 80 ms. A lane draws bars of a fixed
 * pixel width across the song's timeline, so each bar covers a fixed stretch of
 * time (`slotMs`). A bar is the loudest peak that fell inside its slot, which
 * means a bar that has been drawn never changes again: the growing waveform
 * does not shimmer as more audio arrives, it only adds bars on the right.
 */

export const LIVE_PEAK_MS = 80;

export function liveBars(peaks: readonly number[], slotMs: number, pitchMs = LIVE_PEAK_MS): number[] {
  if (!(slotMs > 0) || peaks.length === 0) {
    return [];
  }
  const elapsed = peaks.length * pitchMs;
  const count = Math.ceil(elapsed / slotMs);
  const bars = new Array<number>(count).fill(0);
  for (let i = 0; i < peaks.length; i++) {
    const slot = Math.min(count - 1, Math.floor((i * pitchMs) / slotMs));
    bars[slot] = Math.max(bars[slot] ?? 0, peaks[i] ?? 0);
  }
  // A quiet take should still read: scale by a soft ceiling, not by its own max,
  // so a bar does not jump taller when a louder note arrives later.
  return bars.map((value) => Math.min(1, Math.sqrt(value)));
}

/**
 * The same bars, kept as the take grows: only the peaks that arrived since the
 * last call are folded in (a full rescan per 80 ms tick made a long take cost
 * more with every tick). A slot width that changed, or a list that shrank (a new
 * take), rebuilds from the start. The answer equals `liveBars` for the same input.
 */
export function createLiveBars(pitchMs = LIVE_PEAK_MS): (peaks: readonly number[], slotMs: number) => number[] {
  let seen = 0;
  let slot = 0;
  let maxes: number[] = [];
  let source: readonly number[] | null = null;
  return (peaks, slotMs) => {
    if (!(slotMs > 0) || peaks.length === 0) {
      seen = 0;
      maxes = [];
      slot = slotMs;
      return [];
    }
    if (slotMs !== slot || peaks.length < seen || peaks !== source) {
      seen = 0;
      maxes = [];
      slot = slotMs;
    }
    for (let i = seen; i < peaks.length; i++) {
      const at = Math.floor((i * pitchMs) / slotMs);
      while (maxes.length <= at) {
        maxes.push(0);
      }
      maxes[at] = Math.max(maxes[at] ?? 0, peaks[i] ?? 0);
    }
    seen = peaks.length;
    source = peaks;
    const count = Math.ceil((peaks.length * pitchMs) / slotMs);
    return Array.from({ length: count }, (_, index) => Math.min(1, Math.sqrt(maxes[index] ?? 0)));
  };
}

/**
 * The end of the timeline while recording: the song's own end, or where the
 * take has reached, in steps of five seconds so the scale holds still between
 * steps instead of rescaling every bar on every tick.
 */
export function liveTimelineEndMs(backingEndMs: number, elapsedMs: number): number {
  const wanted = Math.max(backingEndMs, elapsedMs + 1500, 8000);
  return Math.ceil(wanted / 5000) * 5000;
}

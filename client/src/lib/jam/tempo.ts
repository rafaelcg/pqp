/**
 * Tempo, count-in and the tapped-tempo helper.
 */

export interface CountIn {
  /** 0 (no count-in), 1 or 2 bars. */
  bars: 0 | 1 | 2;
  beatsPerBar: number;
  bpm: number;
}

export function beatFrames(bpm: number, sampleRate: number): number {
  return Math.round((60 / bpm) * sampleRate);
}

/** How long the count-in lasts, in whole frames. */
export function countInFrames(c: CountIn | null, sampleRate: number): number {
  if (!c || c.bars === 0) return 0;
  return c.bars * c.beatsPerBar * beatFrames(c.bpm, sampleRate);
}

/** Frames (relative to the count-in's first beat) of every count-in click, and which are accents. */
export function countInClicks(c: CountIn | null, sampleRate: number): { frame: number; accent: boolean }[] {
  if (!c || c.bars === 0) return [];
  const beat = beatFrames(c.bpm, sampleRate);
  const out: { frame: number; accent: boolean }[] = [];
  for (let i = 0; i < c.bars * c.beatsPerBar; i++) {
    out.push({ frame: i * beat, accent: i % c.beatsPerBar === 0 });
  }
  return out;
}

/**
 * BPM from tap times (ms, any clock). Uses the median interval of the last
 * eight taps, so one late tap does not swing it; returns null until there
 * are three taps, or when the taps are further apart than 2 s (30 BPM).
 */
export function tapTempo(tapsMs: number[]): number | null {
  if (tapsMs.length < 3) return null;
  const recent = tapsMs.slice(-9);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) intervals.push(recent[i] - recent[i - 1]);
  const sorted = intervals.filter((d) => d > 0).sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  const mid = sorted.length >> 1;
  const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (med > 2000 || med < 150) return null;
  return Math.round((60000 / med) * 10) / 10;
}

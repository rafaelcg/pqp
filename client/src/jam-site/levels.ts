/**
 * What a tile's level meter and a lane's waveform read from a track's `peaks`.
 *
 * `peaks` are the loudest absolute sample per slice of the WHOLE recorded
 * buffer, trims included (`lib/jam/peaks.ts`), so a position in song time maps
 * to a slice by the same placement rule the engine plays by: the buffer's
 * first sample sits at `offsetMs`, and only `[offset + trimStart, offset +
 * duration - trimEnd)` is audible.
 */

export interface PeakTrack {
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
  peaks: readonly number[];
}

/** Whether the track is audible at this song time. */
export function audibleAt(track: PeakTrack, songMs: number): boolean {
  const start = track.offsetMs + Math.max(0, track.trimStartMs);
  const end = track.offsetMs + track.durationMs - Math.max(0, track.trimEndMs);
  return songMs >= start && songMs < end;
}

/** The peak under `songMs`, 0 when the track is silent there. */
export function peakAt(track: PeakTrack, songMs: number): number {
  if (track.peaks.length === 0 || track.durationMs <= 0 || !audibleAt(track, songMs)) {
    return 0;
  }
  const bufferMs = songMs - track.offsetMs;
  const index = Math.min(
    track.peaks.length - 1,
    Math.max(0, Math.floor((bufferMs / track.durationMs) * track.peaks.length)),
  );
  return track.peaks[index] ?? 0;
}

/**
 * `bars` readings centred on `songMs`, each `stepMs` apart: the little meter
 * of an instrument tile. Oldest first, so the newest sits on the right and the
 * bars read as a level history that moves with the song.
 */
export function levelBars(
  track: PeakTrack,
  songMs: number,
  bars: number,
  stepMs: number,
  scale: number,
): number[] {
  const out: number[] = [];
  for (let k = 0; k < bars; k++) {
    const at = songMs - (bars - 1 - k) * stepMs;
    out.push(Math.min(1, peakAt(track, at) * scale));
  }
  return out;
}

/**
 * A multiplier that makes a track's loudest peak read as full: absolute peaks
 * keep a quiet stem quiet next to a loud one, but a meter that never leaves the
 * floor tells nobody anything, so each meter is scaled to its own track.
 */
export function levelScale(peaks: readonly number[]): number {
  let max = 0;
  for (const value of peaks) {
    if (value > max) max = value;
  }
  return max > 0.02 ? Math.min(8, 1 / max) : 1;
}

/**
 * The bars of a lane: the track laid on the song's timeline, `count` bars
 * across `songDurationMs`. Silence before the part comes in and after it
 * ends is a flat line, which is what shows where each person plays.
 */
export function laneBars(track: PeakTrack, songDurationMs: number, count: number): number[] {
  const scale = levelScale(track.peaks);
  const out: number[] = [];
  if (songDurationMs <= 0 || count <= 0) {
    return out;
  }
  for (let k = 0; k < count; k++) {
    const from = (k / count) * songDurationMs;
    const to = ((k + 1) / count) * songDurationMs;
    // The louder of the slice's ends and middle, so a short peak is not skipped.
    const value = Math.max(peakAt(track, from), peakAt(track, (from + to) / 2), peakAt(track, to - 1));
    out.push(Math.min(1, value * scale));
  }
  return out;
}

/**
 * The little waveform strip of an instrument tile: `count` readings centred on
 * `songMs`, one per peak slice of the track, silent where the part is not
 * playing. Scrolls with the song clock, and sits still when the song does.
 */
export function windowBars(track: PeakTrack, songMs: number, count: number, scale: number): number[] {
  const slice = track.peaks.length > 0 ? track.durationMs / track.peaks.length : 0;
  const step = Math.max(120, slice);
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const at = songMs + (k - (count - 1) / 2) * step;
    out.push(Math.min(1, peakAt(track, at) * scale));
  }
  return out;
}

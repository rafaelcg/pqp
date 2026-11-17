import { NUDGE_LIMIT_MS, type TakeEdits } from "@/lib/jam-take-edit";

/**
 * The clip editor's arithmetic, with no React in it: which stretch of the song
 * the editor shows, where the take sits in it, and the band's waveform behind
 * it, so a take is lined up by eye against what it plays with.
 *
 * Everything is song time in milliseconds (`docs/JAM_ENGINE.md`): a take's
 * buffer starts at `offsetMs`; `trimStartMs` and `trimEndMs` hide a head and a
 * tail of it; the nudge moves all of it.
 */

export interface ClipSource {
  /** Where the buffer starts on the song before any nudge. */
  baseOffsetMs: number;
  /** The whole recorded buffer. */
  durationMs: number;
  /** The head that may never be revealed (the count-in the engine hid); 0 for a posted track. */
  minTrimStartMs: number;
}

export interface ClipWindow {
  startMs: number;
  endMs: number;
}

/** The take's audible stretch on the song, with the edits laid on. */
export function clipSpan(source: ClipSource, edits: Pick<TakeEdits, "trimStartMs" | "trimEndMs" | "nudgeMs">): ClipWindow {
  const offset = source.baseOffsetMs + edits.nudgeMs;
  return {
    startMs: offset + edits.trimStartMs,
    endMs: offset + source.durationMs - edits.trimEndMs,
  };
}

/** The part of the buffer that can be shown at all (everything but the hidden head). */
export function clipReach(source: ClipSource, nudgeMs: number): ClipWindow {
  const offset = source.baseOffsetMs + nudgeMs;
  return { startMs: offset + source.minTrimStartMs, endMs: offset + source.durationMs };
}

/** Room left on each side of the clip, so a handle is never on the edge. */
const PAD_MS = 400;

/**
 * The stretch the editor draws. Whole: the take's full reach at any nudge, so
 * the frame never moves while the clip is dragged. Close: three seconds around
 * where the take starts, where lining up is decided (the first downbeat).
 */
export function clipWindow(source: ClipSource, edits: TakeEdits, zoom: "whole" | "close"): ClipWindow {
  if (zoom === "close") {
    const start = clipSpan(source, edits).startMs;
    return { startMs: start - 1000, endMs: start + 2000 };
  }
  return {
    startMs: source.baseOffsetMs + source.minTrimStartMs - NUDGE_LIMIT_MS - PAD_MS,
    endMs: source.baseOffsetMs + source.durationMs + NUDGE_LIMIT_MS + PAD_MS,
  };
}

/** 0..1 across the window, clamped. */
export function toFraction(window: ClipWindow, ms: number): number {
  const length = Math.max(1, window.endMs - window.startMs);
  return Math.min(1, Math.max(0, (ms - window.startMs) / length));
}

/** Milliseconds per pixel for a window drawn `width` pixels wide. */
export function msPerPixel(window: ClipWindow, width: number): number {
  return (window.endMs - window.startMs) / Math.max(1, width);
}

export interface BandLane {
  peaks: readonly number[];
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
}

/**
 * The band behind the take: `count` heights in 0..1 across the window, each
 * the loudest moment of any in-mix lane in that slice (silence where nobody
 * plays). Loudness is per lane, so a quiet bass still shows under a loud drum.
 */
export function bandEnvelope(lanes: readonly BandLane[], window: ClipWindow, count: number): number[] {
  const out = new Array<number>(Math.max(0, count)).fill(0);
  if (count <= 0) {
    return out;
  }
  const slice = (window.endMs - window.startMs) / count;
  for (const lane of lanes) {
    if (lane.peaks.length === 0 || lane.durationMs <= 0) {
      continue;
    }
    const loudest = Math.max(...lane.peaks) || 1;
    const audibleFrom = lane.offsetMs + lane.trimStartMs;
    const audibleTo = lane.offsetMs + lane.durationMs - lane.trimEndMs;
    for (let i = 0; i < count; i++) {
      const a = Math.max(window.startMs + i * slice, audibleFrom);
      const b = Math.min(window.startMs + (i + 1) * slice, audibleTo);
      if (b <= a) {
        continue;
      }
      const from = Math.floor(((a - lane.offsetMs) / lane.durationMs) * lane.peaks.length);
      const to = Math.max(from + 1, Math.ceil(((b - lane.offsetMs) / lane.durationMs) * lane.peaks.length));
      let peak = 0;
      for (let j = Math.max(0, from); j < Math.min(lane.peaks.length, to); j++) {
        peak = Math.max(peak, lane.peaks[j] ?? 0);
      }
      out[i] = Math.max(out[i]!, peak / loudest);
    }
  }
  return out;
}

/**
 * The take's own bars, `count` of them across the buffer from the hidden head
 * to the end (what the clip draws, handles and all).
 */
export function clipBars(peaks: readonly number[], source: ClipSource, count: number): number[] {
  if (count <= 0) {
    return [];
  }
  if (peaks.length === 0) {
    return new Array<number>(count).fill(0.3);
  }
  const from = Math.floor((source.minTrimStartMs / Math.max(1, source.durationMs)) * peaks.length);
  const usable = peaks.slice(Math.min(from, peaks.length - 1));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor((i * usable.length) / count);
    const b = Math.max(a + 1, Math.floor(((i + 1) * usable.length) / count));
    let peak = 0;
    for (let j = a; j < b && j < usable.length; j++) {
      peak = Math.max(peak, usable[j] ?? 0);
    }
    out.push(peak);
  }
  const loudest = Math.max(...out);
  return loudest > 0 ? out.map((value) => value / loudest) : out;
}

/**
 * How tall a take's waveform is drawn for its volume, as a share of the lane:
 * a quiet take is visibly shorter and a silent one is still a line. The clip
 * editor and the song's lanes use the same number, so what the editor shows
 * while it is open is what the lane keeps showing after "Guardar", and a lane
 * nobody touched stays as it was.
 */
export function levelOfGain(gain: number): number {
  return Math.min(1.12, 0.3 + 0.7 * Math.max(0, Number.isFinite(gain) ? gain : 1));
}

/** "+20%", "-75%"; null at the take's own level (100%). */
export function volumeDelta(gain: number): string | null {
  const percent = Math.round(gain * 100) - 100;
  return percent === 0 ? null : `${percent > 0 ? "+" : "-"}${Math.abs(percent)}%`;
}

/** "+20 ms", "-5 ms", "0 ms". */
export function signedMs(ms: number): string {
  const rounded = Math.round(ms);
  return rounded === 0 ? "0 ms" : `${rounded > 0 ? "+" : "-"}${Math.abs(rounded)} ms`;
}

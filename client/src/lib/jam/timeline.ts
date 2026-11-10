/**
 * Where every stem sits on the song, as arithmetic. No Web Audio here: the
 * player and the offline mixdown both ask this file what to start, when and
 * from where, so the two can never disagree, and the tests can pin it.
 *
 * THE MODEL. A stem is an audio buffer laid on the song's timeline:
 *
 *   song time  ─────────|───────────────[=========audible=========]───────|──▶
 *                    offsetMs      offsetMs+trimStartMs   end-trimEndMs  offsetMs+durationMs
 *   buffer       sample 0 ...............................................last sample
 *
 *   - `offsetMs` is the song time of the buffer's FIRST sample. It may be
 *     negative (a take that starts with its count-in sits partly before 0;
 *     anything before song time 0 is never played).
 *   - `trimStartMs` / `trimEndMs` are how much of the buffer's head and tail
 *     are hidden, both measured from the buffer's own ends, both >= 0. Moving
 *     a trim never moves the audio; moving `offsetMs` (a nudge) moves all of
 *     it. Nothing is ever re-rendered.
 *
 * All of it is in milliseconds on the API (that is what the server stores)
 * and in sample frames here, rounded ONCE per stem, so two stems whose
 * offsets are whole milliseconds at 48 kHz are placed exactly.
 */

export interface StemTiming {
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  /** Length of the whole buffer, untrimmed. */
  durationMs: number;
}

export interface StemMix {
  gain: number;
  muted: boolean;
  solo: boolean;
}

export interface AudibleSpan {
  /** Song time where the stem becomes audible. */
  songStartMs: number;
  /** Song time where it stops. */
  songEndMs: number;
}

export function audibleSpan(t: StemTiming): AudibleSpan | null {
  const trimStart = Math.max(0, t.trimStartMs);
  const trimEnd = Math.max(0, t.trimEndMs);
  const start = t.offsetMs + trimStart;
  const end = t.offsetMs + t.durationMs - trimEnd;
  if (!(end > start)) return null;
  return { songStartMs: start, songEndMs: end };
}

/** The song ends where its last audible stem ends; it always starts at 0. */
export function songDurationMs(stems: Iterable<StemTiming>): number {
  let end = 0;
  for (const s of stems) {
    const span = audibleSpan(s);
    if (span && span.songEndMs > end) end = span.songEndMs;
  }
  return end;
}

export interface ScheduleEntry {
  id: string;
  /** Frames after the segment's start frame at which this source starts. */
  startFrame: number;
  /** Frame inside the buffer to start from. */
  bufferOffsetFrames: number;
  /** How many frames to play. */
  durationFrames: number;
}

const msToFrames = (ms: number, sampleRate: number) => Math.round((ms * sampleRate) / 1000);

/**
 * What to start to play song time `[fromMs, toMs)` from a given frame.
 *
 * The invariant (the reason for the shape of the arithmetic): buffer sample
 * `j` of stem `i` sounds `round((offset_i - fromMs) * sr) + j` frames after
 * the segment starts, whatever the trims, so every stem is placed by one
 * rounding of its offset and nothing else.
 */
export function planSegment(
  stems: ReadonlyArray<{ id: string; timing: StemTiming }>,
  fromMs: number,
  toMs: number,
  sampleRate: number,
): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  const from = Math.max(0, fromMs);
  const segmentFrames = msToFrames(toMs - from, sampleRate);
  if (segmentFrames <= 0) return out;
  for (const { id, timing } of stems) {
    if (!audibleSpan(timing)) continue;
    const d = msToFrames(timing.offsetMs - from, sampleRate);
    const trimStartFrames = msToFrames(Math.max(0, timing.trimStartMs), sampleRate);
    const endBufferFrames = msToFrames(timing.durationMs - Math.max(0, timing.trimEndMs), sampleRate);
    const startFrame = Math.max(0, d + trimStartFrames);
    if (startFrame >= segmentFrames) continue;
    const bufferOffsetFrames = startFrame - d;
    const durationFrames = Math.min(endBufferFrames - bufferOffsetFrames, segmentFrames - startFrame);
    if (durationFrames <= 0) continue;
    out.push({ id, startFrame, bufferOffsetFrames, durationFrames });
  }
  return out;
}

/** Gain each stem actually plays at, after mute and solo. */
export function effectiveGains(stems: ReadonlyArray<{ id: string; mix: StemMix }>): Map<string, number> {
  const anySolo = stems.some((s) => s.mix.solo && !s.mix.muted);
  const out = new Map<string, number>();
  for (const { id, mix } of stems) {
    const audible = !mix.muted && (!anySolo || mix.solo);
    out.set(id, audible ? Math.max(0, mix.gain) : 0);
  }
  return out;
}

export interface LoopRegion {
  startMs: number;
  endMs: number;
}

export interface TransportAnchor {
  /** Song time that leaves the graph at `ctxStart`. */
  songStartMs: number;
  /** AudioContext time (seconds) at which `songStartMs` leaves the graph. */
  ctxStart: number;
  /** Active loop, or null. Only honoured when playback starts before its end. */
  loop: LoopRegion | null;
}

export function loopActive(anchor: TransportAnchor): LoopRegion | null {
  const l = anchor.loop;
  if (!l || !(l.endMs - l.startMs >= 10)) return null;
  return anchor.songStartMs < l.endMs ? l : null;
}

/**
 * Song time leaving the graph at AudioContext time `ctxTime`. Before
 * `ctxStart` the answer is below `songStartMs` (a count-in reads negative
 * relative to where the take starts), which a playhead can clamp.
 */
export function positionAt(anchor: TransportAnchor, ctxTime: number): number {
  const p = anchor.songStartMs + (ctxTime - anchor.ctxStart) * 1000;
  const loop = loopActive(anchor);
  if (!loop || p < loop.endMs) return p;
  const len = loop.endMs - loop.startMs;
  return loop.startMs + ((p - loop.endMs) % len);
}

export interface Segment {
  fromMs: number;
  toMs: number;
  /**
   * Frames after the anchor's frame (`round(ctxStart * sampleRate)`) at which
   * `fromMs` leaves the graph. Whole frames, summed without drift, so pass 100
   * of a loop is still exactly back to back with pass 99.
   */
  startFrames: number;
}

/**
 * The k-th stretch of song the transport plays. Without a loop there is one,
 * from where playback started to `endMs` (the song's end). With a loop, pass
 * 0 runs from the start point to the loop's end and every later pass is the
 * loop region again, back to back with no gap.
 */
export function segmentAt(
  anchor: TransportAnchor,
  k: number,
  endMs: number,
  sampleRate: number,
): Segment | null {
  const loop = loopActive(anchor);
  if (!loop) {
    if (k > 0) return null;
    return { fromMs: anchor.songStartMs, toMs: endMs, startFrames: 0 };
  }
  if (k === 0) return { fromMs: anchor.songStartMs, toMs: loop.endMs, startFrames: 0 };
  const firstFrames = msToFrames(loop.endMs - anchor.songStartMs, sampleRate);
  const loopFrames = msToFrames(loop.endMs - loop.startMs, sampleRate);
  return { fromMs: loop.startMs, toMs: loop.endMs, startFrames: firstFrames + (k - 1) * loopFrames };
}

/** Clamp a seek target onto the song. */
export function clampSeek(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(0, ms), Math.max(0, durationMs));
}

import type { SttOptions, SttProvider, SttResult, SttSegment } from "../types.js";

export interface ReplayCue {
  /** Seconds on the source timeline. */
  start: number;
  end: number;
  text: string;
  /** Passed through as the segment's, so a test can drive the no-speech drop. */
  noSpeechProb?: number;
}

export interface ReplayOptions {
  /** Canned cues on one absolute timeline, as if a single long recording had been transcribed. */
  cues: ReplayCue[];
  /**
   * Position of the audio handed to `transcribe` on that timeline. A caller
   * that cuts windows passes the window's start through `windowStartMs`; with
   * no hint the whole timeline is returned.
   */
  windowStartMs?: (audio: Buffer | string, opts: SttOptions) => number | undefined;
  /** Length of each window, needed with `windowStartMs`. */
  windowMs?: number;
  language?: string;
  /** Artificial latency, so a UI under test sees a request in flight. */
  delayMs?: number;
  /** Every call, for assertions. */
  onCall?: (info: { audio: Buffer | string; opts: SttOptions }) => void;
}

/**
 * A fake provider that returns canned cues. It lets product code (subtitle
 * overlay, stitcher, rate pacing) be tested offline with no key and no network.
 * Cues that overlap the requested window are clipped to it and rebased to the
 * window's own clock, which is what a real provider hands back.
 */
export function createReplayProvider(o: ReplayOptions): SttProvider {
  return {
    id: "replay",
    async transcribe(audio, opts): Promise<SttResult> {
      o.onCall?.({ audio, opts });
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      const startMs = o.windowStartMs?.(audio, opts);
      const windowMs = o.windowMs;
      let segments: SttSegment[];
      let durationMs: number;
      if (startMs === undefined || windowMs === undefined) {
        segments = o.cues.map((c) => ({ ...c }));
        durationMs = Math.round((o.cues.at(-1)?.end ?? 0) * 1000);
      } else {
        const ws = startMs / 1000;
        const we = (startMs + windowMs) / 1000;
        segments = o.cues
          .filter((c) => c.end > ws && c.start < we)
          .map((c) => ({ start: Math.max(c.start, ws) - ws, end: Math.min(c.end, we) - ws, text: c.text }));
        durationMs = windowMs;
      }
      return {
        text: segments.map((s) => s.text).join(" "),
        segments,
        language: o.language ?? opts.language,
        durationMs,
        costUsd: 0,
      };
    },
  };
}

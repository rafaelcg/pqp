import type { JamInstrument } from "@pqp/shared";
import { useEffect, useMemo, useRef } from "react";
import type { JamClock } from "@/hooks/use-jam-playback";
import { levelOfGain } from "@/lib/jam-clip";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { barsFromPeaks, seededBars } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { JamBars, useBarCount } from "./jam-bars";

/**
 * One lane of the song: a track's waveform placed on the SONG's timeline, so
 * every lane lines up with every other and a late entrance starts where it
 * does in the music. The played part is the full-strength bars; the rest is
 * the same bars at half strength. The playhead is written straight to the
 * element from the engine's clock (see `useJamPlayback`), not through React.
 */

export interface JamLaneTiming {
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
}

export interface JamTimeline {
  startMs: number;
  endMs: number;
}

/** The audible stretch of a track on the song timeline, in ms. */
export function laneSpan(timing: JamLaneTiming): { startMs: number; endMs: number } {
  return {
    startMs: timing.offsetMs + timing.trimStartMs,
    endMs: timing.offsetMs + timing.durationMs - timing.trimEndMs,
  };
}

export function JamLaneWave({
  instrument,
  peaks,
  timing,
  timeline,
  clock,
  seed,
  dimmed = false,
  className,
  animate = false,
  playhead = false,
  gain = 1,
}: {
  instrument: JamInstrument;
  peaks: readonly number[];
  timing: JamLaneTiming;
  timeline: JamTimeline;
  clock?: JamClock;
  /** Stable text for the stand-in bars while a track has no peaks. */
  seed: string;
  dimmed?: boolean;
  className?: string;
  animate?: boolean;
  /**
   * Draw the song's playhead in this lane too: where lanes are stacked (a phone)
   * one line cannot cross them all, so each draws its piece at the same place.
   */
  playhead?: boolean | "phone";
  /**
   * The track's own stored volume (its author's): the bars are drawn as tall as
   * it is loud, so a turned-down track looks turned down and its neighbours,
   * which nobody touched, look as they did. 1 is the take as recorded.
   */
  gain?: number;
}) {
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const total = Math.max(1, timeline.endMs - timeline.startMs);
  const span = laneSpan(timing);
  const left = Math.min(1, Math.max(0, (span.startMs - timeline.startMs) / total));
  const right = Math.min(1, Math.max(left, (span.endMs - timeline.startMs) / total));
  const [spanRef, count] = useBarCount(4);
  const played = useRef<HTMLDivElement | null>(null);
  const line = useRef<HTMLDivElement | null>(null);

  const bars = useMemo(() => {
    if (count === 0) {
      return [];
    }
    // A lane is never drawn taller than itself, so +100% looks like 100%; the number says the rest.
    const level = Math.min(1, levelOfGain(gain));
    if (peaks.length === 0) {
      return seededBars(seed, count).map((height) => height * level);
    }
    const from = Math.floor((timing.trimStartMs / Math.max(1, timing.durationMs)) * peaks.length);
    const to = Math.ceil((1 - timing.trimEndMs / Math.max(1, timing.durationMs)) * peaks.length);
    return barsFromPeaks(peaks.slice(from, Math.max(from + 1, to)), count).map((height) => height * level);
  }, [count, peaks, seed, gain, timing.trimStartMs, timing.trimEndMs, timing.durationMs]);

  useEffect(() => {
    if (!clock) {
      return;
    }
    return clock.subscribe((positionMs) => {
      const element = played.current;
      if (!element) {
        return;
      }
      const length = Math.max(1, span.endMs - span.startMs);
      const progress = Math.min(1, Math.max(0, (positionMs - span.startMs) / length));
      element.style.clipPath = `inset(0 0 0 ${progress * 100}%)`;
      if (line.current) {
        line.current.style.left = `${Math.min(1, Math.max(0, (positionMs - timeline.startMs) / total)) * 100}%`;
      }
    });
  }, [clock, span.startMs, span.endMs, timeline.startMs, total]);

  // The lane is the song's whole width, a quiet surface; the take sits on it where
  // it plays (a clip, the way every multitrack draws one) as a whisper of its
  // instrument's colour with the waveform's bars in that colour, so a late
  // entrance or an early end is seen at a glance and the lane is never a slab.
  return (
    <div
      data-jam-wave=""
      className={cn(
        "relative h-[3.25rem] overflow-hidden rounded-[var(--radius-control)] bg-surface-2 transition-opacity duration-[var(--duration-base)] motion-reduce:transition-none",
        dimmed && "opacity-35",
        className,
      )}
    >
      <div
        className={cn("absolute inset-y-0 overflow-hidden rounded-[var(--radius-control)]", look.wash)}
        style={{ left: `${left * 100}%`, width: `${Math.max(0.5, (right - left) * 100)}%` }}
      >
        <div ref={spanRef} className="absolute inset-x-1 inset-y-2">
          <JamBars bars={bars} className="h-full" barClassName={look.bar} animate={animate} />
        </div>
        {/* The bars are drawn once, at full strength; what is still to be played is
            the lane's own surface laid back over them, so a lane costs one bar tree
            and the played part is the one that is fully the instrument's colour. */}
        <div
          ref={played}
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-surface-2 opacity-55"
          style={{ clipPath: "inset(0 0 0 0)" }}
        />
      </div>
      {playhead && clock && (
        <div
          ref={line}
          aria-hidden
          className={cn("pointer-events-none absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 rounded-full bg-text", playhead === "phone" && "sm:hidden")}
        />
      )}
    </div>
  );
}

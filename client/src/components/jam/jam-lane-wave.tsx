import type { JamInstrument } from "@pqp/shared";
import { useEffect, useMemo, useRef } from "react";
import type { JamClock } from "@/hooks/use-jam-playback";
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
}) {
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const total = Math.max(1, timeline.endMs - timeline.startMs);
  const span = laneSpan(timing);
  const left = Math.min(1, Math.max(0, (span.startMs - timeline.startMs) / total));
  const right = Math.min(1, Math.max(left, (span.endMs - timeline.startMs) / total));
  const [spanRef, count] = useBarCount(5);
  const played = useRef<HTMLDivElement | null>(null);

  const bars = useMemo(() => {
    if (count === 0) {
      return [];
    }
    if (peaks.length === 0) {
      return seededBars(seed, count);
    }
    const from = Math.floor((timing.trimStartMs / Math.max(1, timing.durationMs)) * peaks.length);
    const to = Math.ceil((1 - timing.trimEndMs / Math.max(1, timing.durationMs)) * peaks.length);
    return barsFromPeaks(peaks.slice(from, Math.max(from + 1, to)), count);
  }, [count, peaks, seed, timing.trimStartMs, timing.trimEndMs, timing.durationMs]);

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
    });
  }, [clock, span.startMs, span.endMs]);

  // The lane is the song's whole width, a dark track; the take is a block of its
  // instrument's colour sitting where it plays (a clip, the way every multitrack
  // draws one), so a late entrance or an early end is seen at a glance.
  return (
    <div
      className={cn(
        "relative h-12 overflow-hidden rounded-[var(--radius-control)] bg-surface-0/60 transition-opacity duration-[var(--duration-base)]",
        dimmed && "opacity-35",
        className,
      )}
    >
      <div
        className={cn("absolute inset-y-0 overflow-hidden rounded-[var(--radius-control)]", look.fill)}
        style={{ left: `${left * 100}%`, width: `${Math.max(0.5, (right - left) * 100)}%` }}
      >
        <div ref={spanRef} className="absolute inset-x-1 inset-y-1.5">
          <JamBars bars={bars} className="h-full" barClassName="bg-on-inst" animate={animate} />
        </div>
        {/* The bars are drawn once, at full strength; what is still to be played is
            the lane's own colour laid back over them, so a lane costs one bar tree. */}
        <div
          ref={played}
          aria-hidden
          className={cn("pointer-events-none absolute inset-0 opacity-55", look.fill)}
          style={{ clipPath: "inset(0 0 0 0)" }}
        />
      </div>
    </div>
  );
}

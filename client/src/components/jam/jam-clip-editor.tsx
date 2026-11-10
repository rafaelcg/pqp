import type { JamInstrument } from "@pqp/shared";
import { ChevronLeft, ChevronRight, RotateCcw, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import type { JamClock } from "@/hooks/use-jam-playback";
import { useTranslation } from "@/lib/i18n";
import {
  bandEnvelope,
  clipBars,
  clipReach,
  clipSpan,
  clipWindow,
  msPerPixel,
  toFraction,
  type BandLane,
  type ClipSource,
  type ClipWindow,
} from "@/lib/jam-clip";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import type { TakeEdits } from "@/lib/jam-take-edit";
import { cn } from "@/lib/utils";
import { MirrorBars } from "./jam-art";

/**
 * Adjusting a take by touching it: the take is a clip on the song's timeline
 * with the band's waveform drawn behind it, so lining up is seen, not guessed.
 * Drag an end to cut it, drag the middle to move it in time, or use the
 * earlier and later buttons for a few milliseconds at a time. One volume. Every
 * handle is a slider for the keyboard too (arrows, with Shift for big steps).
 *
 * The editor only reports numbers; the caller decides what they do (the studio
 * changes the take before it is sent, a posted track saves with "Guardar").
 */

export interface JamClipEditorProps {
  instrument: JamInstrument;
  /** The take's own peaks over its whole recorded buffer. */
  peaks: readonly number[];
  source: ClipSource;
  edits: TakeEdits;
  /** What it plays with: the other in-mix lanes. */
  band: readonly BandLane[];
  clock?: JamClock;
  onTrimStart: (ms: number) => void;
  onTrimEnd: (ms: number) => void;
  onNudge: (ms: number) => void;
  onGain: (gain: number) => void;
  onReset?: () => void;
  edited: boolean;
  className?: string;
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

type Grip = "start" | "end" | "body";

export function JamClipEditor({
  instrument,
  peaks,
  source,
  edits,
  band,
  clock,
  onTrimStart,
  onTrimEnd,
  onNudge,
  onGain,
  onReset,
  edited,
  className,
}: JamClipEditorProps) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const [zoom, setZoom] = useState<"whole" | "close">("whole");
  const [stageRef, width] = useWidth();
  // While a grip is held the frame does not move under the pointer.
  const held = useRef<{ grip: Grip; x: number; edits: TakeEdits; window: ClipWindow } | null>(null);
  const [dragging, setDragging] = useState<Grip | null>(null);
  const liveWindow = clipWindow(source, edits, zoom);
  const view = held.current?.window ?? liveWindow;

  const span = clipSpan(source, edits);
  const reach = clipReach(source, edits.nudgeMs);
  const at = (ms: number) => `${toFraction(view, ms) * 100}%`;
  const spanLeft = toFraction(view, span.startMs);
  const spanRight = toFraction(view, span.endMs);
  const reachLeft = toFraction(view, reach.startMs);
  const reachRight = toFraction(view, reach.endMs);

  // The take's bars are drawn across its whole reach at the zoom's resolution.
  const reachPx = Math.max(0, (reachRight - reachLeft) * width);
  const takeBars = useMemo(() => clipBars(peaks, source, Math.min(400, Math.floor(reachPx / 4))), [peaks, source, reachPx]);
  const bandBars = useMemo(
    () => bandEnvelope(band, view, Math.min(300, Math.floor(width / 5))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the window's two numbers are its identity
    [band, view.startMs, view.endMs, width],
  );
  const loud = Math.min(1.12, 0.3 + 0.7 * edits.gain);

  // The playhead, written straight to the element from the clock.
  const playhead = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!clock) {
      return;
    }
    return clock.subscribe((positionMs) => {
      const element = playhead.current;
      if (!element) {
        return;
      }
      const inside = positionMs >= view.startMs && positionMs <= view.endMs;
      element.style.opacity = inside ? "1" : "0";
      element.style.left = `${toFraction(view, positionMs) * 100}%`;
    });
  }, [clock, view.startMs, view.endMs]); // eslint-disable-line react-hooks/exhaustive-deps

  function begin(grip: Grip, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    held.current = { grip, x: event.clientX, edits, window: liveWindow };
    setDragging(grip);
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const grab = held.current;
    if (!grab) {
      return;
    }
    const ms = (event.clientX - grab.x) * msPerPixel(grab.window, width);
    if (grab.grip === "start") {
      onTrimStart(grab.edits.trimStartMs + ms);
    } else if (grab.grip === "end") {
      onTrimEnd(grab.edits.trimEndMs - ms);
    } else {
      onNudge(grab.edits.nudgeMs + ms);
    }
  }
  function end() {
    held.current = null;
    setDragging(null);
  }

  function keys(grip: Grip, event: KeyboardEvent<HTMLElement>) {
    const big = event.shiftKey;
    const step = grip === "body" ? (big ? 50 : 10) : big ? 500 : 50;
    const sign = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
    if (sign === 0 && event.key !== "Home") {
      return;
    }
    event.preventDefault();
    if (grip === "start") {
      onTrimStart(event.key === "Home" ? source.minTrimStartMs : edits.trimStartMs + sign * step);
    } else if (grip === "end") {
      onTrimEnd(event.key === "Home" ? 0 : edits.trimEndMs - sign * step);
    } else {
      onNudge(event.key === "Home" ? 0 : edits.nudgeMs + sign * step);
    }
  }

  const cutStart = Math.max(0, edits.trimStartMs - source.minTrimStartMs);
  const nudgeWords =
    edits.nudgeMs === 0
      ? t("jam.clip.onTime")
      : edits.nudgeMs > 0
        ? t("jam.clip.later", { ms: Math.abs(Math.round(edits.nudgeMs)) })
        : t("jam.clip.earlier", { ms: Math.abs(Math.round(edits.nudgeMs)) });

  return (
    <div className={cn("flex flex-col gap-3", className)} data-jam-clip-editor="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[13px] leading-snug text-text [text-wrap:pretty]">{t("jam.clip.hint")}</p>
          <p aria-hidden="true" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-4 rounded-full bg-text-tertiary/70" />
              {t("jam.clip.band")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className={cn("h-2 w-4 rounded-full", look.fill)} />
              {t("jam.clip.yourTake")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-px bg-accent" />
              {t("jam.clip.songStart")}
            </span>
          </p>
        </div>
        <RadioGroup<"whole" | "close">
          label={t("jam.clip.zoom")}
          variant="segmented"
          size="sm"
          fit="content"
          value={zoom}
          onValueChange={setZoom}
          options={[
            { value: "whole", label: t("jam.clip.zoomWhole") },
            { value: "close", label: t("jam.clip.zoomClose") },
          ]}
        />
      </div>

      <div
        ref={stageRef}
        className="relative h-40 touch-none select-none overflow-hidden rounded-[var(--radius-card)] bg-surface-0 ring-1 ring-inset ring-border"
        data-dragging={dragging ?? undefined}
      >
        {/* the band, on its own row right above the take: the beat to line up with */}
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-12 border-b border-border bg-surface-1/60">
          <MirrorBars bars={bandBars} className="absolute inset-x-0 inset-y-2 px-px" barClassName="bg-text-tertiary/70" />
        </div>

        {/* where the song starts: the line a first note lines up with */}
        {view.startMs < 0 && view.endMs > 0 && (
          <span aria-hidden="true" className="absolute inset-y-0 w-px bg-accent" style={{ left: at(0) }} />
        )}

        {/* the take: its whole reach, the cut parts shaded */}
        <div
          className={cn("absolute bottom-3 top-[3.75rem] overflow-hidden rounded-[var(--radius-control)]", look.fill)}
          style={{ left: `${reachLeft * 100}%`, width: `${Math.max(0, reachRight - reachLeft) * 100}%` }}
        >
          <div className="absolute inset-x-1 inset-y-1.5 origin-center" style={{ transform: `scaleY(${loud})` }}>
            <MirrorBars bars={takeBars} className="h-full gap-[2px]" barClassName="bg-on-inst" />
          </div>
        </div>
        <div
          aria-hidden="true"
          className="jam-cut absolute bottom-3 top-[3.75rem] rounded-l-[var(--radius-control)] bg-surface-0/75"
          style={{ left: `${reachLeft * 100}%`, width: `${Math.max(0, spanLeft - reachLeft) * 100}%` }}
        />
        <div
          aria-hidden="true"
          className="jam-cut absolute bottom-3 top-[3.75rem] rounded-r-[var(--radius-control)] bg-surface-0/75"
          style={{ left: `${spanRight * 100}%`, width: `${Math.max(0, reachRight - spanRight) * 100}%` }}
        />

        {/* the middle: drag to move the take in time */}
        <div
          role="slider"
          tabIndex={0}
          aria-label={t("jam.clip.move")}
          aria-valuemin={-500}
          aria-valuemax={500}
          aria-valuenow={edits.nudgeMs}
          aria-valuetext={nudgeWords}
          data-jam-clip-body=""
          onPointerDown={(event) => begin("body", event)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={(event) => keys("body", event)}
          className={cn(
            "absolute bottom-3 top-[3.75rem] rounded-[var(--radius-control)] outline-none ring-2 ring-inset ring-text/0 transition-[box-shadow] duration-[var(--duration-fast)] hover:ring-text/40 focus-visible:ring-focus-ring",
            dragging === "body" ? "cursor-grabbing ring-text/60" : "cursor-grab",
          )}
          style={{ left: `${spanLeft * 100}%`, width: `${Math.max(0, spanRight - spanLeft) * 100}%` }}
        />

        {(["start", "end"] as const).map((grip) => {
          const value = grip === "start" ? cutStart : edits.trimEndMs;
          return (
            <div
              key={grip}
              role="slider"
              tabIndex={0}
              aria-label={grip === "start" ? t("jam.clip.cutStart") : t("jam.clip.cutEnd")}
              aria-valuemin={0}
              aria-valuemax={Math.round(source.durationMs)}
              aria-valuenow={Math.round(value)}
              aria-valuetext={t("jam.clip.cutValue", { seconds: (value / 1000).toFixed(1) })}
              data-jam-clip-handle={grip}
              onPointerDown={(event) => begin(grip, event)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={(event) => keys(grip, event)}
              className="group absolute bottom-1.5 top-[3.4rem] z-10 flex w-5 -translate-x-1/2 cursor-ew-resize items-center justify-center outline-none"
              style={{ left: at(grip === "start" ? span.startMs : span.endMs) }}
            >
              <span
                className={cn(
                  "flex h-full w-2.5 flex-col items-center justify-center gap-[3px] rounded-full bg-text shadow-[var(--shadow-2)] ring-2 ring-surface-0 transition-transform duration-[var(--duration-fast)] group-hover:scale-x-125 group-focus-visible:ring-focus-ring",
                  dragging === grip && "scale-x-125",
                )}
              >
                <span className="h-0.5 w-1 rounded-full bg-surface-0" />
                <span className="h-0.5 w-1 rounded-full bg-surface-0" />
                <span className="h-0.5 w-1 rounded-full bg-surface-0" />
              </span>
            </div>
          );
        })}

        <div ref={playhead} aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-20 w-0.5 rounded-full bg-text opacity-0" />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-1.5" role="group" aria-label={t("jam.clip.move")}>
          <button
            type="button"
            aria-label={t("jam.review.nudgeEarlier")}
            onClick={() => onNudge(edits.nudgeMs - 10)}
            data-jam-nudge="earlier"
            className="flex h-10 items-center gap-1 whitespace-nowrap rounded-full bg-surface-2 pl-2 pr-3 text-xs font-bold text-text outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t("jam.review.nudgeEarlier")}
          </button>
          <span className="min-w-[6.5rem] text-center text-xs font-semibold tabular-nums text-text-secondary" aria-live="polite">
            {nudgeWords}
          </span>
          <button
            type="button"
            aria-label={t("jam.review.nudgeLater")}
            onClick={() => onNudge(edits.nudgeMs + 10)}
            data-jam-nudge="later"
            className="flex h-10 items-center gap-1 whitespace-nowrap rounded-full bg-surface-2 pl-3 pr-2 text-xs font-bold text-text outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {t("jam.review.nudgeLater")}
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex min-w-[12rem] flex-1 items-center gap-2.5">
          <Volume2 className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
          <span className="shrink-0 text-xs font-semibold text-text-secondary">{t("jam.review.volume")}</span>
          <Slider
            variant="volume"
            min={0}
            max={200}
            step={1}
            value={Math.round(edits.gain * 100)}
            onValueChange={(value) => onGain(value / 100)}
            aria-label={t("jam.review.volume")}
            className="min-w-0 flex-1"
          />
          <span className="w-14 text-right text-xs font-semibold tabular-nums text-text-secondary">
            {Math.round(edits.gain * 100) === 100
              ? t("jam.clip.volumeNormal")
              : `${edits.gain > 1 ? "+" : "-"}${Math.abs(Math.round(edits.gain * 100) - 100)}%`}
          </span>
        </div>
      </div>

      <div className="flex min-h-8 items-center justify-end gap-2 text-xs text-text-secondary">
        {onReset && edited && (
          <Button variant="ghost" size="sm" className="gap-1.5 text-text" onClick={onReset} data-jam-clip-reset="">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {t("jam.review.reset")}
          </Button>
        )}
      </div>
    </div>
  );
}

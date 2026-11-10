import { Loader2, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import type { JamClock } from "@/hooks/use-jam-playback";
import { useTranslation } from "@/lib/i18n";
import { formatClock } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";

/**
 * Play, the scrubber and the clock. The position text and the slider are fed by
 * the engine's clock at a calm 10 Hz (a number nobody can read faster), while
 * the lanes' playheads, which are only drawn, follow it every frame.
 */

function useClockReadout(clock: JamClock): { positionMs: number; durationMs: number } {
  const [reading, setReading] = useState({ positionMs: 0, durationMs: 0 });
  const last = useRef(0);
  // The latest duration shown, read by the subscription (a value captured from the
  // first render would be 0 forever and make every tick look like a change).
  const shownDuration = useRef(0);
  useEffect(
    () =>
      clock.subscribe((positionMs, durationMs) => {
        const now = performance.now();
        if (now - last.current < 100 && durationMs === shownDuration.current) {
          return;
        }
        last.current = now;
        shownDuration.current = durationMs;
        setReading({ positionMs, durationMs });
      }),
    [clock],
  );
  return reading;
}

export function JamTransport({
  clock,
  playing,
  loading,
  durationMs,
  onToggle,
  onSeek,
  title,
  className,
  size = "md",
  caption,
  label,
  scrubber = true,
}: {
  clock: JamClock;
  playing: boolean;
  loading: boolean;
  durationMs: number;
  onToggle: () => void;
  onSeek: (ms: number) => void;
  /** Names the play button: "Tocar In Bloom". */
  title: string;
  className?: string;
  /** `lg`: the song's own transport, the biggest round button on the panel after "Gravar". */
  size?: "md" | "lg";
  /** A quiet line beside the clock ("3 instrumentos"). */
  caption?: string;
  /** A word beside the button ("Ouvir a banda"), for a transport that is not obviously a player. */
  label?: string;
  /**
   * Draw the position bar. Off where the lanes already have a ruler and a playhead
   * across them: two indicators of one position, at two x's, disagree.
   */
  scrubber?: boolean;
}) {
  const { t } = useTranslation();
  const reading = useClockReadout(clock);
  const length = Math.max(durationMs, reading.durationMs, 1);
  const lg = size === "lg";
  return (
    <div className={cn("flex items-center gap-3.5", className)}>
      <button
        type="button"
        onClick={onToggle}
        disabled={loading && !playing}
        data-jam-play=""
        data-state={playing ? "playing" : "paused"}
        aria-label={playing ? t("jam.song.pause") : t("jam.song.play", { title })}
        className={cn(
          "relative grid shrink-0 place-items-center rounded-full bg-text text-surface-0 shadow-[var(--shadow-2)] outline-none transition-[background,transform] duration-[var(--duration-fast)] hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 active:scale-[0.95] disabled:opacity-60",
          lg ? "h-14 w-14" : "h-12 w-12",
          label && "w-auto gap-2 px-5",
        )}
      >
        {loading && !playing ? (
          <Loader2 className="h-5 w-5 motion-safe:animate-spin" aria-hidden />
        ) : playing ? (
          <Pause className={lg ? "h-6 w-6" : "h-5 w-5"} aria-hidden fill="currentColor" />
        ) : (
          // optical centring: a play triangle sits a hair right of its box
          <Play className={cn("ml-0.5", lg ? "h-6 w-6" : "h-5 w-5")} aria-hidden fill="currentColor" />
        )}
        {label && <span className="text-sm font-extrabold">{label}</span>}
      </button>
      {!scrubber ? (
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-sm font-semibold tabular-nums text-text">
            {formatClock(Math.min(reading.positionMs, length))}
            <span className="text-text-secondary"> / {formatClock(length)}</span>
          </span>
          {caption && <span className="truncate text-[13px] font-semibold text-text-secondary">{caption}</span>}
        </div>
      ) : (
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Slider
          variant="scrub"
          min={0}
          max={Math.round(length)}
          step={10}
          value={Math.round(Math.min(reading.positionMs, length))}
          onValueChange={onSeek}
          aria-label={t("jam.song.position")}
          disabled={durationMs === 0}
        />
        <span className="flex items-center justify-between gap-2 text-xs tabular-nums text-text-secondary">
          <span className={cn(lg && "text-sm font-semibold text-text")}>
            {formatClock(Math.min(reading.positionMs, length))}
            <span className="text-text-tertiary"> / {formatClock(length)}</span>
          </span>
          {caption && <span className="truncate font-semibold text-text-tertiary">{caption}</span>}
        </span>
      </div>
      )}
    </div>
  );
}

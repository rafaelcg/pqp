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
  useEffect(
    () =>
      clock.subscribe((positionMs, durationMs) => {
        const now = performance.now();
        if (now - last.current < 100 && durationMs === reading.durationMs) {
          return;
        }
        last.current = now;
        setReading({ positionMs, durationMs });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the readout reads its own last value
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
}) {
  const { t } = useTranslation();
  const reading = useClockReadout(clock);
  const length = Math.max(durationMs, reading.durationMs, 1);
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <button
        type="button"
        onClick={onToggle}
        disabled={loading && !playing}
        data-jam-play=""
        aria-label={playing ? t("jam.song.pause") : t("jam.song.play", { title })}
        className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent text-on-accent outline-none transition-[background,transform] duration-[var(--duration-fast)] hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 active:scale-[0.96] disabled:opacity-60"
      >
        {loading && !playing ? (
          <Loader2 className="h-5 w-5 motion-safe:animate-spin" aria-hidden />
        ) : playing ? (
          <Pause className="h-5 w-5" aria-hidden fill="currentColor" />
        ) : (
          // optical centring: a play triangle sits a hair right of its box
          <Play className="ml-0.5 h-5 w-5" aria-hidden fill="currentColor" />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
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
        <span className="text-xs tabular-nums text-text-secondary">
          {formatClock(reading.positionMs)} / {formatClock(length)}
        </span>
      </div>
    </div>
  );
}

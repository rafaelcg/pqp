import type { PublicJamTrack } from "@pqp/shared";
import { FlagIcon as Flag } from "./icons";
import { useCallback, useMemo, useRef } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { asInstrument, inkMix, INSTRUMENT_LOOK, type Instrument } from "./instruments";
import { laneBars } from "./levels";
import type { PublicPlayer } from "./player";
import { Badge } from "./tiles";
import { useClockDraw } from "./use-player";
import { cn, instrumentName, partLabel, personLabel } from "./util";

/**
 * "Quem tocou o quê": one lane per part, each a waveform laid on the song's
 * own timeline (silent before the part comes in, silent after it ends), the
 * played part lit and one playhead through all of them. A flag per part opens
 * the report sheet (reporting needs an account). A missing instrument is a
 * dashed lane with no button: the one way to record is the button under the
 * stage.
 */

const BARS = 140;
const H = 40;

function barPath(values: readonly number[]): string {
  const step = 100 / values.length;
  return values
    .map((value, i) => {
      const h = Math.max(2, value * (H - 4));
      const x = (i * step).toFixed(3);
      return `M${x},${((H - h) / 2).toFixed(2)}h${(step * 0.62).toFixed(3)}v${h.toFixed(2)}h-${(step * 0.62).toFixed(3)}z`;
    })
    .join("");
}

function Wave({ track, durationMs, player }: { track: PublicJamTrack; durationMs: number; player: PublicPlayer }) {
  const instrument = asInstrument(track.instrument);
  const path = useMemo(() => barPath(laneBars(track, durationMs, BARS)), [track, durationMs]);
  const root = useRef<HTMLDivElement | null>(null);
  const seekFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    player.seek(((event.clientX - box.left) / box.width) * durationMs);
  };
  return (
    <div
      ref={root}
      data-jam-wave={track.id}
      onPointerDown={seekFromPointer}
      className="relative h-10 w-full cursor-pointer overflow-hidden rounded-[var(--radius-control)] bg-surface-1"
      style={{ color: inkMix(instrument) }}
    >
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full opacity-[var(--jam-wave-dim,0.38)]" aria-hidden="true">
        <path d={path} fill="currentColor" />
      </svg>
      <svg
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full [clip-path:inset(0_calc(100%_-_var(--p,0%))_0_0)]"
        aria-hidden="true"
      >
        <path d={path} fill="currentColor" />
      </svg>
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-text" style={{ left: "var(--p, 0%)" }} />
    </div>
  );
}

export function SongLanes({
  tracks,
  needs,
  durationMs,
  player,
  spot,
  onReport,
}: {
  tracks: readonly PublicJamTrack[];
  needs: readonly Instrument[];
  durationMs: number;
  player: PublicPlayer;
  spot: number | null;
  onReport: (trackId: string) => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const total = Math.max(1, durationMs);
  const draw = useCallback(() => {
    root.current?.style.setProperty("--p", `${Math.min(100, (player.position() / total) * 100)}%`);
  }, [player, total]);
  useClockDraw(player, draw);

  return (
    <section aria-labelledby="jam-lanes-title" data-jam-lanes="">
      <h2 id="jam-lanes-title" className="text-xl font-extrabold">
        {jt("lanes.title")}
      </h2>
      <div ref={root} className="mt-3 divide-y divide-border border-y border-border">
        {tracks.map((track, index) => {
          const instrument = asInstrument(track.instrument);
          const who = personLabel(track.person);
          const dim = spot !== null && spot !== index;
          return (
            <div
              key={track.id}
              data-jam-lane={track.id}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 md:grid-cols-[13rem_minmax(0,1fr)_auto] md:gap-x-4",
                dim && "opacity-60",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <Badge instrument={instrument} className="h-9 w-9" />
                <div className="min-w-0 leading-tight">
                  <p className="truncate font-bold">{who}</p>
                  <p className="truncate text-[13px] text-text-secondary">
                    {partLabel(track)}
                    {track.person.handle ? ` · @${track.person.handle}` : ""}
                  </p>
                </div>
              </div>
              <div className="order-last col-span-2 md:order-none md:col-span-1">
                <Wave track={track} durationMs={total} player={player} />
              </div>
              <button
                type="button"
                onClick={() => onReport(track.id)}
                aria-label={jt("lanes.report", { name: who })}
                data-jam-report-part={track.id}
                className="grid h-9 w-9 place-items-center rounded-full text-text-tertiary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11 pointer-coarse:w-11"
              >
                <Flag className="h-4 w-4" aria-hidden />
              </button>
            </div>
          );
        })}
        {needs.slice(0, 3).map((instrument) => (
          <div key={instrument} data-jam-lane-missing={instrument} className="flex items-center gap-3 py-3">
            <span
              aria-hidden="true"
              className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 border-dashed", INSTRUMENT_LOOK[instrument].dashed, INSTRUMENT_LOOK[instrument].ink)}
            >
              {(() => {
                const Icon = INSTRUMENT_LOOK[instrument].icon;
                return <Icon className="h-4 w-4" strokeWidth={2} />;
              })()}
            </span>
            <div className="leading-tight">
              <p className="font-bold capitalize">{instrumentName(instrument)}</p>
              <p className="text-[13px] text-text-secondary">{jt("lanes.missing")}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

import type { PublicJamTrack } from "@pqp/shared";
import { CopyrightIcon as Copyright, EllipsisIcon as Ellipsis, FlagIcon as Flag } from "./icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * played part lit and one playhead through all of them. Reporting a part is in
 * the lane's own small menu (reporting needs an account), not a flag on every
 * row: nine flags in a column read as noise. A missing instrument is a dashed
 * lane with no button: the one way to record is the button under the stage.
 */

/**
 * The lane's menu: one quiet "more" button that opens a small popover with
 * "Report this part" and "Copyright problem" (the same report, already filed
 * as a copyright one). Keyboard all the way: Enter, Space or the down arrow
 * opens it and puts focus on the first item, the arrows move between the two,
 * Escape closes it and gives focus back,
 * Tab leaves, and a press outside closes it. Choosing the item hands focus back
 * to the button first, so the sheet that opens returns there when it closes.
 */
function LaneMenu({
  name,
  trackId,
  onReport,
  onCopyright,
}: {
  name: string;
  trackId: string;
  onReport: (trackId: string) => void;
  onCopyright: (trackId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        } else if (event.key === "Tab" && open) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={jt("lanes.more", { name })}
        data-jam-lane-menu={trackId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="grid h-9 w-9 place-items-center rounded-full text-text-tertiary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring aria-expanded:bg-surface-2 aria-expanded:text-text pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <Ellipsis className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={jt("lanes.more", { name })}
          className="absolute right-0 top-full z-20 mt-1 min-w-[17rem] rounded-[var(--radius-card)] border border-border bg-surface-1 p-1 shadow-[var(--shadow-2)]"
        >
          <button
            ref={first}
            type="button"
            role="menuitem"
            data-jam-report-part={trackId}
            onClick={() => {
              trigger.current?.focus();
              setOpen(false);
              onReport(trackId);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                (event.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
              }
            }}
            className="flex h-10 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 text-left text-sm font-semibold text-text outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring pointer-coarse:h-11"
          >
            <Flag className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
            {jt("lanes.report")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-jam-copyright-part={trackId}
            onClick={() => {
              trigger.current?.focus();
              setOpen(false);
              onCopyright(trackId);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                first.current?.focus();
              }
            }}
            className="flex h-10 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 text-left text-sm font-semibold text-text outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring pointer-coarse:h-11"
          >
            <Copyright className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
            {jt("lanes.copyright")}
          </button>
        </div>
      )}
    </div>
  );
}

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
      {/* still to play: a plain neutral grey, not a dimmed copy of the hue (a dimmed yellow is khaki, a dimmed violet is slate) */}
      <svg
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full text-[color-mix(in_oklab,var(--color-text)_32%,var(--color-surface-1))]"
        aria-hidden="true"
      >
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
  onCopyright,
}: {
  tracks: readonly PublicJamTrack[];
  needs: readonly Instrument[];
  durationMs: number;
  player: PublicPlayer;
  spot: number | null;
  onReport: (trackId: string) => void;
  onCopyright: (trackId: string) => void;
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
              <LaneMenu name={who} trackId={track.id} onReport={onReport} onCopyright={onCopyright} />
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

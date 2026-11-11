import type { JamInstrument } from "@pqp/shared";
import type { ReactNode } from "react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";

/**
 * The ONE lane layout, shared by an open song and the studio's review.
 *
 * Wide (the band is 40rem or more across; a CONTAINER query, because the song
 * panel is a side panel on a desktop and "wide" is the panel's width, not the
 * window's): one line per lane, three columns. The instrument's badge and the
 * name with the person or the status under it, in a column of fixed width that
 * truncates with an ellipsis and has nothing laid over it; the waveform, which
 * takes whatever is left; the lane's controls at the right.
 *
 * Narrow: the lane wraps to two lines, the identity with the controls and then
 * the waveform. The controls drop to a line of their own only when they do not
 * fit beside the name, so nothing is ever drawn on top of anything.
 *
 * The ruler (`Ruler` in the song panel) uses the same two variables, so its
 * labels sit exactly over the waveform column.
 */

/** Put these on the box that holds the ruler and the lanes, with `--lane-ctl` beside it: the room the controls need. */
export const JAM_BAND_BOX = "@container/band [--lane-id:10rem]";

/** The band's width above which a lane is one line. */
export const BAND_WIDE = "@min-[40rem]/band";

export function JamLaneFrame({
  identity,
  controls,
  wave,
  className,
}: {
  identity: ReactNode;
  controls?: ReactNode;
  wave: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-jam-lane-frame=""
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5",
        "@min-[40rem]/band:grid @min-[40rem]/band:grid-cols-[var(--lane-id)_minmax(0,1fr)_var(--lane-ctl)] @min-[40rem]/band:gap-x-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-24 @min-[40rem]/band:col-start-1 @min-[40rem]/band:row-start-1 @min-[40rem]/band:basis-auto">{identity}</div>
      {controls ? (
        <div
          data-jam-lane-controls=""
          className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-0.5 @min-[40rem]/band:col-start-3 @min-[40rem]/band:row-start-1 @min-[40rem]/band:ml-0 @min-[40rem]/band:flex-nowrap"
        >
          {controls}
        </div>
      ) : null}
      <div className="min-w-0 basis-full @min-[40rem]/band:col-start-2 @min-[40rem]/band:row-start-1 @min-[40rem]/band:basis-auto">{wave}</div>
    </div>
  );
}

/**
 * Who a lane is: the instrument's badge (its colour and its icon, so colour is
 * never the only cue), the instrument's name, and under it the person or the
 * status. Both lines truncate with an ellipsis (the whole text is the tooltip),
 * so the column never grows into its neighbours.
 */
export function JamLaneIdentity({
  instrument,
  title,
  sub,
  subTitle,
  dashed = false,
  recording = false,
  dimmed = false,
  muted = false,
}: {
  instrument: JamInstrument;
  /** The instrument's name, already translated. */
  title?: string;
  /** The line under it: the person, "tu", "gravando", "no tempo". */
  sub: ReactNode;
  /** The text of `sub` as plain words, for the native tooltip when it is cut. */
  subTitle?: string;
  /** A part nobody has recorded yet: the badge is an outline. */
  dashed?: boolean;
  recording?: boolean;
  /** Another lane is soloed: this one sits back. */
  dimmed?: boolean;
  /** A take that is not in the song: its words are secondary. */
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const Icon = look.icon;
  const name = title ?? t(look.nameKey as MessageKey);
  return (
    <div data-jam-lane-identity="" className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          "relative grid h-9 w-9 shrink-0 place-items-center rounded-full motion-safe:transition-opacity motion-safe:duration-[var(--duration-base)]",
          dashed ? cn("border-2 border-dashed border-current", look.ink) : look.fill,
          dimmed && "opacity-40",
        )}
      >
        {recording && <span className="jam-rec-ring absolute inset-0 rounded-full bg-danger" />}
        <Icon className="relative h-[18px] w-[18px]" />
      </span>
      <span
        data-jam-lane-name=""
        className={cn(
          "flex min-w-0 flex-1 flex-col leading-tight motion-safe:transition-opacity motion-safe:duration-[var(--duration-base)]",
          dimmed && "opacity-40",
        )}
      >
        <span title={name} className={cn("truncate text-sm font-extrabold", muted ? "text-text-secondary" : "text-text")}>
          {name}
        </span>
        <span
          title={subTitle}
          // a narrow band gives the name up to two short lines (a person is told apart by the end of a name); a wide one cuts it with an ellipsis
          className="line-clamp-2 min-w-0 text-xs text-text-secondary [overflow-wrap:anywhere] @min-[40rem]/band:line-clamp-none @min-[40rem]/band:block @min-[40rem]/band:truncate"
        >
          {sub}
        </span>
      </span>
    </div>
  );
}

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { INSTRUMENT_LOOK, type Instrument } from "./instruments";
import type { MosaicLayout } from "./mosaic";
import { cn } from "./util";

/**
 * The pieces a mosaic is made of, shared by the song page (live: video, a level
 * that moves with the song) and the home's small pictures (still: a cover or
 * squares in the instrument's colour).
 */

/** The grid itself. Children are placed by `layout.cells`, in order. */
export function MosaicGrid({
  layout,
  children,
  className,
  label,
  gap = 2,
}: {
  layout: MosaicLayout;
  children: ReactNode[];
  className?: string;
  label?: string;
  gap?: number;
}) {
  const style: CSSProperties = {
    gridTemplateColumns: layout.columns.map((w) => `${w}fr`).join(" "),
    gridTemplateRows: layout.rows.map((h) => `${h}fr`).join(" "),
    aspectRatio: String(layout.aspect),
    gap,
  };
  return (
    <div
      role={label ? "group" : undefined}
      aria-label={label}
      data-mosaic=""
      data-mosaic-count={children.length}
      data-mosaic-orientation={layout.orientation}
      style={style}
      className={cn("grid w-full overflow-hidden bg-media-scrim", className)}
    >
      {children.map((child, index) => {
        const cell = layout.cells[index];
        if (!cell) return null;
        return (
          <div
            key={index}
            className="relative min-h-0 min-w-0 overflow-hidden"
            style={{
              gridColumn: `${cell.col} / span ${cell.colSpan}`,
              gridRow: `${cell.row} / span ${cell.rowSpan}`,
            }}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}

/** Bars drawn from numbers 0..1, in the instrument's colour. Pure markup. */
export function Bars({
  instrument,
  values,
  className,
}: {
  instrument: Instrument;
  values: readonly number[];
  className?: string;
}) {
  const look = INSTRUMENT_LOOK[instrument];
  return (
    <span aria-hidden="true" className={cn("flex h-7 items-center justify-center gap-[3px]", className)}>
      {values.map((value, index) => (
        <i
          key={index}
          className={cn("block w-[3px] rounded-full", look.bar)}
          style={{ height: `${Math.round(18 + Math.min(1, Math.max(0, value)) * 82)}%` }}
        />
      ))}
    </span>
  );
}

/**
 * A level meter that is driven from outside React: `draw` is called by the
 * owner every frame and writes `--h` heights straight onto the bars, so a
 * second of playback is not sixty renders. Pass the `register` callback to get
 * the function that paints.
 */
export function LiveBars({
  instrument,
  count,
  paint,
  className,
}: {
  instrument: Instrument;
  count: number;
  /** Gets the painter; call it with `count` values. Returns a cleanup. */
  paint: (apply: (values: readonly number[]) => void) => () => void;
  className?: string;
}) {
  const look = INSTRUMENT_LOOK[instrument];
  const root = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const bars = Array.from(element.children) as HTMLElement[];
    return paint((values) => {
      for (let k = 0; k < bars.length; k++) {
        const v = Math.min(1, Math.max(0, values[k] ?? 0));
        bars[k]!.style.height = `${Math.round(14 + v * 86)}%`;
      }
    });
  }, [paint]);
  return (
    <span
      ref={root}
      aria-hidden="true"
      data-jam-level=""
      className={cn("flex h-9 items-center justify-center gap-[3px]", className)}
    >
      {Array.from({ length: count }, (_, index) => (
        <i key={index} className={cn("block w-[3px] rounded-full", look.bar)} style={{ height: "14%" }} />
      ))}
    </span>
  );
}

/** The instrument's glyph in its colour. */
export function Glyph({ instrument, className }: { instrument: Instrument; className?: string }) {
  const look = INSTRUMENT_LOOK[instrument];
  const Icon = look.icon;
  return <Icon aria-hidden className={cn(look.ink, className)} strokeWidth={1.75} />;
}

/** The small round badge a name chip and a dashed tile carry. */
export function Badge({ instrument, className }: { instrument: Instrument; className?: string }) {
  const look = INSTRUMENT_LOOK[instrument];
  const Icon = look.icon;
  return (
    <span
      aria-hidden="true"
      className={cn("grid shrink-0 place-items-center rounded-full", look.fill, className)}
    >
      <Icon className="h-[55%] w-[55%]" strokeWidth={2} />
    </span>
  );
}

/** The ground of an audio-only tile. */
export function tileGround(instrument: Instrument): string {
  return INSTRUMENT_LOOK[instrument].ground;
}

/**
 * The still stand-in for a part on a list: its colour, its glyph and a strip of
 * the song's own peaks, so no two squares of a card are the same pattern.
 */
export function StillTile({
  instrument,
  bars,
  name,
}: {
  instrument: Instrument;
  bars: readonly number[];
  /** The person's name, drawn as a chip when the picture is large enough to read it. */
  name?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "@container/still absolute inset-0 flex flex-col items-center justify-center gap-[6%]",
        tileGround(instrument),
      )}
    >
      <Glyph instrument={instrument} className="h-[26%] w-[26%] min-h-5 min-w-5" />
      <Bars instrument={instrument} values={bars} className="hidden h-[16%] @min-[5rem]/still:flex" />
      {name && (
        <span className="absolute bottom-2 left-2 hidden max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-media-scrim/80 py-1 pl-1 pr-2.5 text-xs font-bold text-on-media @min-[9rem]/still:flex">
          <Badge instrument={instrument} className="h-5 w-5" />
          <span className="truncate">{name}</span>
        </span>
      )}
    </div>
  );
}

/** The dashed "your part here" tile; words only when the picture is large enough for them. */
export function NeedStill({ instrument, label }: { instrument: Instrument; label?: string }) {
  const look = INSTRUMENT_LOOK[instrument];
  return (
    <div aria-hidden="true" className={cn("@container/stillneed absolute inset-0 grid place-items-center", tileGround(instrument))}>
      <span className={cn("pointer-events-none absolute inset-[6%] rounded-[var(--radius-card)] border-2 border-dashed", look.dashed)} />
      <span className="relative flex flex-col items-center gap-2 px-2 text-center">
        <Badge instrument={instrument} className="h-9 w-9 @min-[9rem]/stillneed:h-12 @min-[9rem]/stillneed:w-12" />
        {label && <span className="hidden text-sm font-bold leading-tight text-on-media @min-[9rem]/stillneed:block">{label}</span>}
      </span>
    </div>
  );
}

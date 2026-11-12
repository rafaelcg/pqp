import type { CSSProperties, ReactNode } from "react";
import { LevelStrip, MoreBody, PersonMark, StackDot, TileCaption } from "@/lib/jam-tile-parts";
import { INSTRUMENT_LOOK, type Instrument } from "./instruments";
import type { MosaicLayout } from "./mosaic";
import { cn } from "./util";

/**
 * The pieces a mosaic is made of, shared by the song page (live: video, a level
 * that moves with the song) and the home's small pictures (still: a square in
 * the instrument's colour). The colours, the caption, the level strip and the
 * "+N" tile are `lib/jam-tile-parts.tsx` and `lib/jam-tile-look.ts`, the same
 * ones the app's song view draws with.
 */

/** The grid itself. Children are placed by `layout.cells`, in order, or by `order` (the cell of each child). */
export function MosaicGrid({
  layout,
  children,
  className,
  label,
  gap = 3,
  aspect,
  order,
}: {
  layout: MosaicLayout;
  children: ReactNode[];
  className?: string;
  label?: string;
  gap?: number;
  /** A fixed width over height, for a row of pictures that must line up whatever their count. */
  aspect?: number;
  /** For each child, the index of the cell it sits on. The DOM order never changes (a video that moves in the document pauses). */
  order?: readonly number[];
}) {
  const style: CSSProperties = {
    gridTemplateColumns: layout.columns.map((w) => `${w}fr`).join(" "),
    gridTemplateRows: layout.rows.map((h) => `${h}fr`).join(" "),
    aspectRatio: String(aspect ?? layout.aspect),
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
      className={cn("grid w-full overflow-hidden bg-surface-0", className)}
    >
      {children.map((child, index) => {
        const cell = layout.cells[order?.[index] ?? index];
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

/** The instrument's glyph in its tile ink. */
export function Glyph({ instrument, className }: { instrument: Instrument; className?: string }) {
  const look = INSTRUMENT_LOOK[instrument];
  const Icon = look.icon;
  return <Icon aria-hidden className={cn(look.tile.ink, className)} strokeWidth={1.75} />;
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

/**
 * The still stand-in for a part on a list: the person (their picture, or an
 * initial) on the instrument's own ground with a strip of the song's own peaks,
 * so a card is a row of faces and no two squares of it are the same.
 */
export function StillTile({
  instrument,
  bars,
  name,
  avatarUrl,
  caption = false,
}: {
  instrument: Instrument;
  bars: readonly number[];
  name: string;
  avatarUrl: string | null;
  /** The person's name, drawn as a caption when the picture is large enough to read it. */
  caption?: boolean;
}) {
  const look = INSTRUMENT_LOOK[instrument];
  const Icon = look.icon;
  return (
    // the container is the tile; the column that centres the person is its child, so its own gaps can use the tile's units
    <div aria-hidden="true" className={cn("absolute inset-0 [container:tile/size]", look.tile.ground, look.tile.ink)}>
      <div className="flex h-full w-full flex-col items-center justify-center gap-[5cqmin] pb-[6cqmin]">
      <PersonMark
        avatarUrl={avatarUrl}
        name={name}
        fill={look.fill}
        initialFill={look.tile.solid}
        icon={<Icon className="h-[58%] w-[58%]" strokeWidth={2} />}
      />
      <LevelStrip count={bars.length} values={bars} className="hidden h-[10cqmin] max-h-6 [--jam-level-gap:3px] @min-[7rem]/tile:flex" />
      </div>
      {caption && (
        <span className="hidden @min-[9rem]/tile:contents">
          <TileCaption mark={<Badge instrument={instrument} className="h-4 w-4" />} name={name} tone="ground" />
        </span>
      )}
    </div>
  );
}

/** The dashed "your part here" tile: a neutral ground so it reads as a slot, not a part; words only when the picture is large enough. */
export function NeedStill({ instrument, label }: { instrument: Instrument; label?: string }) {
  const look = INSTRUMENT_LOOK[instrument];
  return (
    <div aria-hidden="true" className="@container/tile absolute inset-0 grid place-items-center bg-surface-2">
      {/* the dashed outline is the hero's; a small card slot is a quiet neutral tile with the badge */}
      {label && <span className={cn("pointer-events-none absolute inset-[7%] rounded-[var(--radius-card)] border-2 border-dashed", look.tile.dashed)} />}
      <span className="relative flex flex-col items-center gap-2 px-2 text-center">
        <Badge instrument={instrument} className="h-8 w-8 @min-[9rem]/tile:h-10 @min-[9rem]/tile:w-10" />
        {label && <span className="hidden text-sm font-bold leading-tight text-text @min-[9rem]/tile:block">{label}</span>}
      </span>
    </div>
  );
}

/** "+N" on a card or the hero: the number and the instruments hidden behind it. */
export function MoreStill({ count, instruments }: { count: number; instruments: readonly Instrument[] }) {
  return (
    <div aria-hidden="true" className="absolute inset-0 [container:tile/size]">
      <MoreBody
        count={count}
        dots={instruments.slice(0, 3).map((instrument) => {
          const look = INSTRUMENT_LOOK[instrument];
          const Icon = look.icon;
          return (
            <StackDot key={instrument} fill={look.fill}>
              <Icon className="h-3 w-3" strokeWidth={2.25} />
            </StackDot>
          );
        })}
      />
    </div>
  );
}

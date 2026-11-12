import { forwardRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import "./jam-tile.css";

/**
 * The pieces of a mosaic tile that the public site and the app's song view
 * draw the SAME way. Icons are not here (the site draws its own small set, the
 * app uses lucide) and neither is the arithmetic of the layout: callers hand
 * in what is theirs and this owns what has to match.
 *
 * Imports nothing but React, so the light site bundle can take it.
 *
 * Every piece sizes itself from the TILE it sits in, a container named `tile`
 * (`@container/tile`, or `container: tile / size` where `cqmin` is used), so a
 * ninth of a stage and a whole stage both look right and no piece asks about
 * the window.
 */

const join = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

/**
 * Who a tile is: a small solid mark of the instrument, and the person's name.
 *
 * Two tones. Over a VIDEO the name sits on a dark pill (the picture can be any
 * colour). On a flat ground it is plain text in the text colour, because a dark
 * pill on a pastel tile is a charcoal block again. Smaller than the first
 * version, at the bottom edge: a caption is not a face-sized object. Below
 * 120 px of tile the name goes and the mark stays (the lane below, and the
 * tile's own accessible name, still say who it is).
 */
export function TileCaption({
  mark,
  name,
  label,
  tone,
  className,
  ...rest
}: {
  /** The instrument's small badge, drawn by the caller (its icon). */
  mark: ReactNode;
  name: string;
  /** What the person plays, when it is more than the glyph says; shown only on a roomy tile. */
  label?: string;
  tone: "media" | "ground";
  className?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children" | "title">) {
  return (
    <span
      data-jam-caption=""
      title={label ? `${name} · ${label}` : name}
      {...rest}
      className={join(
        "pointer-events-none absolute bottom-1 left-1 z-[1] flex max-w-[calc(100%-0.5rem)] items-center gap-1 rounded-full text-[11px] font-bold leading-4",
        "@min-[16rem]/tile:bottom-2 @min-[16rem]/tile:left-2 @min-[16rem]/tile:gap-1.5 @min-[16rem]/tile:text-[13px] @min-[16rem]/tile:leading-5",
        tone === "media" ? "bg-media-scrim/80 py-0.5 pl-0.5 pr-2 text-on-media @max-[7.5rem]/tile:pr-0.5" : "text-text",
        className,
      )}
    >
      {mark}
      <span className="truncate @max-[7.5rem]/tile:hidden">
        <span data-jam-caption-person="">{name}</span>
        {label && (
          <span data-jam-caption-label="" className={join("hidden font-semibold @min-[11rem]/tile:inline", tone === "media" ? "text-on-media-muted" : "text-text-secondary")}>
            {" · "}
            {label}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * The strip of bars under a part with no video. Paint it with
 * `paintLevelStrip(element, values)` from outside React (a frame loop writes a
 * few style properties, no render). Its colour is `currentColor`: give it the
 * instrument's ink class.
 */
export const LevelStrip = forwardRef<
  HTMLSpanElement,
  { count: number; values?: readonly number[]; className?: string } & Omit<HTMLAttributes<HTMLSpanElement>, "children">
>(function LevelStrip({ count, values, className, ...rest }, ref) {
  return (
    <span ref={ref} aria-hidden="true" data-jam-level="" {...rest} className={join("jam-level", className)}>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} style={values ? ({ transform: levelTransform(values[index] ?? 0) } as CSSProperties) : undefined} />
      ))}
    </span>
  );
});

/** The loudness of a bar as the height it is drawn at: silence is no bar at all (the baseline is drawn by the strip). */
export function levelHeight(value: number): number {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  return v < 0.03 ? 0 : 0.14 + 0.86 * v;
}

export function levelTransform(value: number): string {
  return `scaleY(${levelHeight(value).toFixed(3)})`;
}

/** Writes `values` (0..1) onto the strip's bars. Cheap enough for every frame. */
export function paintLevelStrip(strip: HTMLElement, values: readonly number[]): void {
  const bars = strip.children;
  for (let index = 0; index < bars.length; index += 1) {
    (bars[index] as HTMLElement).style.transform = levelTransform(values[index] ?? 0);
  }
}

/**
 * Who a part with no video is: the person's picture, or their initial on the
 * instrument's colour, with the instrument's icon as a badge on it. The biggest
 * thing on the tile, sized from the tile (`cqmin`, so the tile must be a size
 * container). The caller passes its own icon and fill class.
 */
export function PersonMark({
  avatarUrl,
  name,
  fill,
  icon,
  className,
}: {
  avatarUrl: string | null;
  name: string;
  /** The instrument's solid fill class (with its dark ink). */
  fill: string;
  icon: ReactNode;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={join("relative grid aspect-square h-[44cqmin] min-h-10 max-h-44 place-items-center", className)} data-jam-person="">
      {avatarUrl && !broken ? (
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        <span aria-hidden="true" className={join("grid h-full w-full place-items-center rounded-full font-display text-[14cqmin] font-extrabold leading-none", fill)}>
          {Array.from(name)[0]?.toUpperCase() ?? "?"}
        </span>
      )}
      <span aria-hidden="true" className={join("absolute -bottom-0.5 -right-0.5 grid h-[26%] min-h-5 w-[26%] min-w-5 place-items-center rounded-full ring-2 ring-surface-0", fill)}>
        {icon}
      </span>
    </span>
  );
}

/**
 * "+N": the parts that did not get a tile of their own. Not a plain grey box:
 * the number, and a small stack of the instruments hidden behind it, so it
 * says what is in there and not only how many.
 */
export function MoreBody({ count, dots, className }: { count: number; dots: ReactNode; className?: string }) {
  return (
    <span className={join("flex h-full w-full flex-col items-center justify-center gap-[6cqmin] bg-surface-3 text-text", className)}>
      <span aria-hidden="true" className="font-display text-[24cqmin] font-extrabold leading-none tracking-[-0.02em]">
        +{count}
      </span>
      <span aria-hidden="true" className="flex items-center -space-x-1.5">
        {dots}
      </span>
    </span>
  );
}

/** One small solid circle of an instrument for the stack under a "+N", its icon drawn by the caller. */
export function StackDot({ fill, children }: { fill: string; children: ReactNode }) {
  return (
    <span className={join("grid h-5 w-5 place-items-center rounded-full ring-2 ring-surface-3 @max-[7.5rem]/tile:h-4 @max-[7.5rem]/tile:w-4", fill)}>{children}</span>
  );
}

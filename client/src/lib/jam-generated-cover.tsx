import type { CSSProperties } from "react";

/**
 * THE COVER A SONG HAS WHEN NOBODY PICKED ONE.
 *
 * A song with no cover used to show whatever each surface improvised: a flat yellow bar in the share
 * card, a letter, a note icon. That reads as a glitch, and on launch day most songs have no cover.
 * This is one deliberate picture, used by every small cover slot (the public site's thumbnail, the
 * share card, the picker, the shelf, the quick switcher, "Tuas musicas"):
 *
 *   - DETERMINISTIC from the song id (and the instruments on it), so the same song looks the same on
 *     every surface and every device, and two songs rarely look alike. Nothing is stored or fetched.
 *   - FLAT AND OPAQUE: a ground in one instrument's colour and three flat shapes in the others'. Every
 *     colour is an existing role token (`--color-inst-*`, `--color-on-inst`), so it follows the theme
 *     and no colour is written here. No gradient, no translucency, no blur.
 *   - IT SAYS WHO IS ON THE SONG: the colours are the instruments of its parts, the way the wall's art
 *     is, so the band is readable before a word is.
 *
 * It is pure on purpose (`generatedCoverSpec`): the unfurl image cannot use it (a link preview is a
 * PNG; see docs/JAM_SITE.md, "The picture"), so a coverless song unfurls as the generic jam card.
 */

export type CoverInstrument = "guitar" | "bass" | "drums" | "vocals" | "keys" | "other";

const INSTRUMENTS: readonly CoverInstrument[] = ["vocals", "guitar", "bass", "drums", "keys", "other"];

/** The CSS custom property that holds each colour: the role tokens, never a literal. */
export const COVER_TOKEN: Record<CoverInstrument | "ink", string> = {
  guitar: "var(--color-inst-guitar)",
  bass: "var(--color-inst-bass)",
  drums: "var(--color-inst-drums)",
  vocals: "var(--color-inst-vocals)",
  keys: "var(--color-inst-keys)",
  other: "var(--color-inst-other)",
  ink: "var(--color-on-inst)",
};

export type CoverShapeKind = "circle" | "half" | "square" | "bar" | "quarter";

export interface CoverShape {
  kind: CoverShapeKind;
  /** The token it is filled with (a key of `COVER_TOKEN`). */
  color: CoverInstrument | "ink";
  /** On a 100 by 100 grid. A shape may run past the edge: the picture crops it. */
  x: number;
  y: number;
  size: number;
  /** 0, 90, 180 or 270: which way a half or a quarter faces. */
  turn: 0 | 90 | 180 | 270;
}

export interface GeneratedCoverSpec {
  /** The ground: one instrument's colour. */
  ground: CoverInstrument;
  shapes: CoverShape[];
}

/** FNV-1a, 32 bits: the same string is the same number everywhere. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** A small deterministic generator (mulberry32) seeded from the hash. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: readonly CoverShapeKind[] = ["circle", "half", "square", "bar", "quarter"];
const TURNS = [0, 90, 180, 270] as const;
/** Where the three shapes sit: three anchors of a 3 by 3 grid, so a cover is always composed, never a pile. */
const ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [18, 20],
  [64, 16],
  [22, 62],
  [66, 64],
  [42, 40],
];

const asCover = (value: string): CoverInstrument => ((INSTRUMENTS as readonly string[]).includes(value) ? (value as CoverInstrument) : "other");

/**
 * What to draw for a song. `instruments` are the instruments on it (a part's instrument each, repeats
 * allowed, any order); with none, the id alone picks the colours. Never throws, never returns an empty
 * picture.
 */
export function generatedCoverSpec(songId: string, instruments: readonly string[] = []): GeneratedCoverSpec {
  const next = random(hash(songId));
  const band = INSTRUMENTS.filter((one) => instruments.some((given) => asCover(given) === one));
  // With nothing known the id picks the band, so an unknown song is not always yellow.
  const colours = band.length > 0 ? band : [INSTRUMENTS[Math.floor(next() * INSTRUMENTS.length)]!];
  const ground = colours[Math.floor(next() * colours.length)]!;
  // The shapes are in the OTHER instruments' colours; a one-instrument song has none, so its shapes are the dark ink.
  const others: Array<CoverInstrument | "ink"> = colours.filter((one) => one !== ground);
  const palette: Array<CoverInstrument | "ink"> = others.length >= 2 ? others : [...others, "ink"];
  // A shuffle from OUR generator (Fisher-Yates), not `sort(() => random)`: an engine's sort with an
  // inconsistent comparator orders differently in Safari and Chrome, and this must be the same everywhere.
  const anchors = [...ANCHORS];
  for (let index = anchors.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [anchors[index], anchors[swap]] = [anchors[swap]!, anchors[index]!];
  }
  anchors.length = 3;
  const shapes: CoverShape[] = anchors.map(([x, y], index) => ({
    kind: KINDS[Math.floor(next() * KINDS.length)]!,
    color: palette[(index + Math.floor(next() * palette.length)) % palette.length]!,
    x,
    y,
    size: 26 + Math.floor(next() * 22),
    turn: TURNS[Math.floor(next() * TURNS.length)]!,
  }));
  return { ground, shapes };
}

function ShapePath({ shape }: { shape: CoverShape }) {
  const { kind, x, y, size: s, turn } = shape;
  const fill = COVER_TOKEN[shape.color];
  const spin = `rotate(${turn} ${x + s / 2} ${y + s / 2})`;
  switch (kind) {
    case "circle":
      return <circle cx={x + s / 2} cy={y + s / 2} r={s / 2} fill={fill} />;
    case "square":
      return <rect x={x} y={y} width={s} height={s} rx={s * 0.12} fill={fill} transform={spin} />;
    case "bar":
      return <rect x={x} y={y + s * 0.3} width={s * 1.5} height={s * 0.4} rx={s * 0.2} fill={fill} transform={spin} />;
    case "half":
      // A half disc whose flat side faces `turn`.
      return <path d={`M${x} ${y + s / 2}a${s / 2} ${s / 2} 0 0 1 ${s} 0z`} fill={fill} transform={spin} />;
    case "quarter":
      return <path d={`M${x} ${y + s}V${y}a${s} ${s} 0 0 1 ${s} ${s}z`} fill={fill} transform={spin} />;
  }
}

/**
 * The picture, filling its positioned parent (`absolute inset-0`) or sized by `className`. Decorative: a
 * cover slot names the song beside it, so this carries no text for a screen reader.
 */
export function JamGeneratedCover({
  songId,
  instruments,
  className,
  style,
}: {
  songId: string;
  instruments?: readonly string[];
  className?: string;
  style?: CSSProperties;
}) {
  const spec = generatedCoverSpec(songId, instruments);
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      data-jam-generated-cover=""
      data-ground={spec.ground}
      className={className ?? "absolute inset-0 h-full w-full"}
      style={style}
    >
      <rect width="100" height="100" fill={COVER_TOKEN[spec.ground]} />
      {spec.shapes.map((shape, index) => (
        <ShapePath key={index} shape={shape} />
      ))}
    </svg>
  );
}

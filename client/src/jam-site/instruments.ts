import { DrumIcon as Drum, GuitarIcon as Guitar, MicVocalIcon as MicVocal, MusicIcon as Music, Music2Icon as Music2, PianoIcon as Piano, type IconComponent } from "./icons";

/**
 * The six instruments, as the public site draws them. The app's own table is
 * `lib/jam-instruments.ts`; it reads `@pqp/shared` at run time, which would put
 * the whole contract package in this light bundle, so the site keeps this small
 * copy of the same colour roles (`--color-inst-*`) and the same icons. The
 * colour tokens are the single source of the hues; a drift here is a drift in
 * icon only, and `instruments.test.ts` pins the ids against the contract.
 *
 * Class strings are written out in full because Tailwind reads source text.
 */
export type Instrument = "guitar" | "bass" | "drums" | "vocals" | "keys" | "other";

export const INSTRUMENTS: readonly Instrument[] = [
  "vocals",
  "guitar",
  "bass",
  "drums",
  "keys",
  "other",
];

export interface InstrumentLook {
  icon: IconComponent;
  /** Solid fill with its dark label: the glyph's badge. */
  fill: string;
  /** The colour as ink on a plain surface. */
  ink: string;
  /** The ground of a tile: the colour at a whisper over the media black. */
  ground: string;
  /** Bars and strokes, pulled toward the text colour so a pale yellow stays a line on a light page. */
  bar: string;
  /** A dashed outline in the colour. */
  dashed: string;
  /** The CSS custom property that holds the hue, for `style`. */
  token: string;
}

const bar = (name: string) =>
  `bg-[color-mix(in_oklab,var(--color-inst-${name})_80%,var(--color-text))] [:root[data-theme=light]_&]:bg-[color-mix(in_oklab,var(--color-inst-${name})_54%,var(--color-text))]`;

export const INSTRUMENT_LOOK: Record<Instrument, InstrumentLook> = {
  guitar: {
    icon: Guitar,
    fill: "bg-inst-guitar text-on-inst",
    ink: "text-inst-guitar",
    ground: "bg-[color-mix(in_oklab,var(--color-inst-guitar)_14%,var(--color-media-scrim))]",
    bar: bar("guitar"),
    dashed: "border-inst-guitar",
    token: "--color-inst-guitar",
  },
  bass: {
    icon: Music2,
    fill: "bg-inst-bass text-on-inst",
    ink: "text-inst-bass",
    ground: "bg-[color-mix(in_oklab,var(--color-inst-bass)_14%,var(--color-media-scrim))]",
    bar: bar("bass"),
    dashed: "border-inst-bass",
    token: "--color-inst-bass",
  },
  drums: {
    icon: Drum,
    fill: "bg-inst-drums text-on-inst",
    ink: "text-inst-drums",
    ground: "bg-[color-mix(in_oklab,var(--color-inst-drums)_14%,var(--color-media-scrim))]",
    bar: bar("drums"),
    dashed: "border-inst-drums",
    token: "--color-inst-drums",
  },
  vocals: {
    icon: MicVocal,
    fill: "bg-inst-vocals text-on-inst",
    ink: "text-inst-vocals",
    ground: "bg-[color-mix(in_oklab,var(--color-inst-vocals)_14%,var(--color-media-scrim))]",
    bar: bar("vocals"),
    dashed: "border-inst-vocals",
    token: "--color-inst-vocals",
  },
  keys: {
    icon: Piano,
    fill: "bg-inst-keys text-on-inst",
    ink: "text-inst-keys",
    ground: "bg-[color-mix(in_oklab,var(--color-inst-keys)_14%,var(--color-media-scrim))]",
    bar: bar("keys"),
    dashed: "border-inst-keys",
    token: "--color-inst-keys",
  },
  other: {
    icon: Music,
    fill: "bg-inst-other text-on-inst",
    ink: "text-inst-other",
    ground: "bg-[color-mix(in_oklab,var(--color-inst-other)_14%,var(--color-media-scrim))]",
    bar: bar("other"),
    dashed: "border-inst-other",
    token: "--color-inst-other",
  },
};

/**
 * The instrument's colour as a line on the page behind it: pulled toward the
 * text colour (`--jam-ink-mix`, 80% on dark and 54% on light, set in
 * `jam-site.css`) so a pale yellow stays visible on a light page. For SVG
 * fills and borders that cannot take a utility class.
 */
export function inkMix(instrument: Instrument): string {
  return `color-mix(in oklab, var(${INSTRUMENT_LOOK[instrument].token}) var(--jam-ink-mix, 80%), var(--color-text))`;
}

export function isInstrument(value: string): value is Instrument {
  return (INSTRUMENTS as readonly string[]).includes(value);
}

/** An instrument id the server may grow: anything unknown is "other". */
export function asInstrument(value: string): Instrument {
  return isInstrument(value) ? value : "other";
}

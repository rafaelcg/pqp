import { JAM_TILE_LOOK, type JamTileLook } from "@/lib/jam-tile-look";
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
  /** Ground, ink, dashed outline and dot of a part's tile: the one table the app's song view draws from too. */
  tile: JamTileLook;
  /** A dashed outline in the colour. */
  dashed: string;
  /** The CSS custom property that holds the hue, for `style`. */
  token: string;
}

export const INSTRUMENT_LOOK: Record<Instrument, InstrumentLook> = {
  guitar: {
    icon: Guitar,
    fill: "bg-inst-guitar text-on-inst",
    ink: "text-inst-guitar",
    tile: JAM_TILE_LOOK.guitar,
    dashed: "border-inst-guitar",
    token: "--color-inst-guitar",
  },
  bass: {
    icon: Music2,
    fill: "bg-inst-bass text-on-inst",
    ink: "text-inst-bass",
    tile: JAM_TILE_LOOK.bass,
    dashed: "border-inst-bass",
    token: "--color-inst-bass",
  },
  drums: {
    icon: Drum,
    fill: "bg-inst-drums text-on-inst",
    ink: "text-inst-drums",
    tile: JAM_TILE_LOOK.drums,
    dashed: "border-inst-drums",
    token: "--color-inst-drums",
  },
  vocals: {
    icon: MicVocal,
    fill: "bg-inst-vocals text-on-inst",
    ink: "text-inst-vocals",
    tile: JAM_TILE_LOOK.vocals,
    dashed: "border-inst-vocals",
    token: "--color-inst-vocals",
  },
  keys: {
    icon: Piano,
    fill: "bg-inst-keys text-on-inst",
    ink: "text-inst-keys",
    tile: JAM_TILE_LOOK.keys,
    dashed: "border-inst-keys",
    token: "--color-inst-keys",
  },
  other: {
    icon: Music,
    fill: "bg-inst-other text-on-inst",
    ink: "text-inst-other",
    tile: JAM_TILE_LOOK.other,
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

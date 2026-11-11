import { JAM_INSTRUMENTS, type JamInstrument } from "@pqp/shared";
import {
  Drum,
  Guitar,
  MicVocal,
  Music,
  Music2,
  Piano,
  type LucideIcon,
} from "lucide-react";

/**
 * What a jam instrument looks like. The colours are role tokens
 * (`--color-inst-*`, `index.css`), told apart by lightness as well as hue, and
 * every one has its own icon so colour is never the only cue. The class
 * strings are written out in full because Tailwind finds a class by reading
 * the source, not by evaluating it.
 */
export interface JamInstrumentLook {
  icon: LucideIcon;
  /** A solid fill with its dark label: a tile, a lane, an avatar chip. */
  fill: string;
  /** The same colour as a text colour, for a mark on a plain surface. */
  ink: string;
  /** The instrument's colour at a whisper, for the ground a lane's waveform sits on. */
  wash: string;
  /**
   * The waveform's bars: the instrument's colour pulled a little toward the text
   * colour, so a pale yellow stays a visible line on a light surface and a deep
   * blue on a dark one, in either theme. On the light theme it is pulled further,
   * because a pale yellow bar on a pale lane is the one thing that cannot be read.
   */
  bar: string;
  /** i18n key of the instrument's name. */
  nameKey: string;
  /** i18n key of "falta <instrument>" for a song that wants one. */
  missingKey: string;
}

export const JAM_INSTRUMENT_LOOK: Record<JamInstrument, JamInstrumentLook> = {
  guitar: {
    icon: Guitar,
    fill: "bg-inst-guitar text-on-inst",
    ink: "text-inst-guitar",
    wash: "bg-[color-mix(in_oklab,var(--color-inst-guitar)_16%,transparent)]",
    bar: "bg-[color-mix(in_oklab,var(--color-inst-guitar)_80%,var(--color-text))] [:root[data-theme=light]_&]:bg-[color-mix(in_oklab,var(--color-inst-guitar)_54%,var(--color-text))]",
    nameKey: "jam.instrument.guitar",
    missingKey: "jam.needs.missing.guitar",
  },
  bass: {
    icon: Music2,
    fill: "bg-inst-bass text-on-inst",
    ink: "text-inst-bass",
    wash: "bg-[color-mix(in_oklab,var(--color-inst-bass)_16%,transparent)]",
    bar: "bg-[color-mix(in_oklab,var(--color-inst-bass)_80%,var(--color-text))] [:root[data-theme=light]_&]:bg-[color-mix(in_oklab,var(--color-inst-bass)_54%,var(--color-text))]",
    nameKey: "jam.instrument.bass",
    missingKey: "jam.needs.missing.bass",
  },
  drums: {
    icon: Drum,
    fill: "bg-inst-drums text-on-inst",
    ink: "text-inst-drums",
    wash: "bg-[color-mix(in_oklab,var(--color-inst-drums)_16%,transparent)]",
    bar: "bg-[color-mix(in_oklab,var(--color-inst-drums)_80%,var(--color-text))] [:root[data-theme=light]_&]:bg-[color-mix(in_oklab,var(--color-inst-drums)_54%,var(--color-text))]",
    nameKey: "jam.instrument.drums",
    missingKey: "jam.needs.missing.drums",
  },
  vocals: {
    icon: MicVocal,
    fill: "bg-inst-vocals text-on-inst",
    ink: "text-inst-vocals",
    wash: "bg-[color-mix(in_oklab,var(--color-inst-vocals)_16%,transparent)]",
    bar: "bg-[color-mix(in_oklab,var(--color-inst-vocals)_80%,var(--color-text))] [:root[data-theme=light]_&]:bg-[color-mix(in_oklab,var(--color-inst-vocals)_54%,var(--color-text))]",
    nameKey: "jam.instrument.vocals",
    missingKey: "jam.needs.missing.vocals",
  },
  keys: {
    icon: Piano,
    fill: "bg-inst-keys text-on-inst",
    ink: "text-inst-keys",
    wash: "bg-[color-mix(in_oklab,var(--color-inst-keys)_16%,transparent)]",
    bar: "bg-[color-mix(in_oklab,var(--color-inst-keys)_80%,var(--color-text))] [:root[data-theme=light]_&]:bg-[color-mix(in_oklab,var(--color-inst-keys)_54%,var(--color-text))]",
    nameKey: "jam.instrument.keys",
    missingKey: "jam.needs.missing.keys",
  },
  other: {
    icon: Music,
    fill: "bg-inst-other text-on-inst",
    ink: "text-inst-other",
    wash: "bg-[color-mix(in_oklab,var(--color-inst-other)_16%,transparent)]",
    bar: "bg-[color-mix(in_oklab,var(--color-inst-other)_80%,var(--color-text))] [:root[data-theme=light]_&]:bg-[color-mix(in_oklab,var(--color-inst-other)_54%,var(--color-text))]",
    nameKey: "jam.instrument.other",
    missingKey: "jam.needs.missing.other",
  },
};

/** The order a picker lists them in: the common band first. */
export const JAM_INSTRUMENT_ORDER: readonly JamInstrument[] = [
  "vocals",
  "guitar",
  "bass",
  "drums",
  "keys",
  "other",
];

export function isJamInstrument(value: string): value is JamInstrument {
  return (JAM_INSTRUMENTS as readonly string[]).includes(value);
}

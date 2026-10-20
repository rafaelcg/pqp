import type { Strings } from "./i18n";
import { formatFactor } from "./stage";
import { fill } from "./ui/dom";

/**
 * The turbo's speed, as numbers and nothing else: what a ratio may be, how it is snapped, how it is written
 * ("4,5x"), and what the popover under the Turbo button shows for it. `hud.ts` draws the popover and
 * `emulator.ts` hands the ratio to the core; neither needs to know the rules, so the rules live here and
 * are tested alone.
 */

/** 1x is the game's own speed, so it is also where turbo stops doing anything. */
export const TURBO_MIN = 1;
export const TURBO_MAX = 10;
export const TURBO_STEP = 0.5;
export const DEFAULT_TURBO_RATIO = 3;
/** The quick picks under the slider. */
export const TURBO_PRESETS = [2, 4, 8, 10] as const;
/** What PageUp and PageDown move the slider by. */
export const TURBO_PAGE_STEP = 1;
/**
 * Above this speed the game's own sound is held back: a core fast-forwarding at 10x writes audio that is shrill and
 * choppy, and silence is kinder than that. It is 3x because 2x and 3x still sound like the game.
 */
export const TURBO_MUTE_ABOVE = 3;

/** The speed turbo actually runs at: 0 is off, anything else is a ratio above 1. */
export type Turbo = number;

/**
 * A ratio snapped to the step and held between the limits. Anything that is not a finite number (a bad stored
 * value, a NaN from a half-typed field) is the default, never a throw and never 1x by accident.
 */
export function clampTurboRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TURBO_RATIO;
  const snapped = Math.round(value / TURBO_STEP) * TURBO_STEP;
  return Math.min(TURBO_MAX, Math.max(TURBO_MIN, snapped));
}

/** The ratio that goes to the core: a float, between the limits, never 0 and never above what we ever offer. */
export function coreRatio(turbo: number): number {
  if (!Number.isFinite(turbo)) return TURBO_MIN;
  return Math.min(TURBO_MAX, Math.max(TURBO_MIN, turbo));
}

/** A ratio at 1x (or below) does nothing: turbo is "off" for it. */
export function isIdleRatio(ratio: number): boolean {
  return ratio <= TURBO_MIN;
}

/** Does the game's sound stay off at this speed? */
export function silencesGame(turbo: number): boolean {
  return turbo > TURBO_MUTE_ABOVE;
}

/** "4.5", "4,5" in the languages that write it so, "3" for a whole number. */
export function formatRatio(ratio: number, locale?: string): string {
  return formatFactor(ratio, locale, Number.isInteger(ratio) ? 0 : 1);
}

/** The next ratio for a key on the slider, or null when the key is not the slider's. */
export function ratioForKey(ratio: number, key: string): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clampTurboRatio(ratio + TURBO_STEP);
    case "ArrowLeft":
    case "ArrowDown":
      return clampTurboRatio(ratio - TURBO_STEP);
    case "PageUp":
      return clampTurboRatio(ratio + TURBO_PAGE_STEP);
    case "PageDown":
      return clampTurboRatio(ratio - TURBO_PAGE_STEP);
    case "Home":
      return TURBO_MIN;
    case "End":
      return TURBO_MAX;
    default:
      return null;
  }
}

export interface TurboPopoverModel {
  ratio: number;
  /** "4.5x": the big live number. */
  readout: string;
  /** What a screen reader says for the slider's value. */
  valueText: string;
  /** The slider sits at 1x: turbo would do nothing. */
  idle: boolean;
  /** The game is silent at this speed, and the popover says so. */
  silent: boolean;
  /** 0 to 100, how far along the track the thumb is. */
  percent: number;
  minLabel: string;
  maxLabel: string;
  presets: Array<{ ratio: number; label: string; checked: boolean }>;
}

export function turboPopoverModel(ratio: number, t: Strings, locale?: string): TurboPopoverModel {
  const value = clampTurboRatio(ratio);
  const n = formatRatio(value, locale);
  const idle = isIdleRatio(value);
  return {
    ratio: value,
    readout: `${n}x`,
    valueText: idle ? t["hud.turboValueOff"] : fill(t["hud.turboValue"], { n }),
    idle,
    silent: silencesGame(value),
    percent: ((value - TURBO_MIN) / (TURBO_MAX - TURBO_MIN)) * 100,
    minLabel: `${formatRatio(TURBO_MIN, locale)}x`,
    maxLabel: `${formatRatio(TURBO_MAX, locale)}x`,
    presets: TURBO_PRESETS.map((preset) => ({ ratio: preset, label: `${formatRatio(preset, locale)}x`, checked: preset === value })),
  };
}

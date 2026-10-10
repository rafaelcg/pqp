/**
 * Seasonal looks: when the picker offers them and when the corner card invites.
 *
 * The windows are the only switch. Nothing ships dark and nothing needs a
 * deploy to turn on: Christmas appears in the picker on its first day and the
 * card starts inviting the same day. Outside the window the look is hidden from
 * the picker, except for somebody who still has it on, who keeps it until they
 * pick something else.
 *
 * Dates are the reader's local calendar, which is the one a holiday follows.
 */

import type { AppearancePreference } from "@pqp/shared";
import { browserStorage } from "./arrival";

export type SeasonalLook = Extract<AppearancePreference, "halloween" | "christmas">;

export const SEASONAL_LOOKS: readonly SeasonalLook[] = ["halloween", "christmas"];

/** Month 1 to 12. A window whose end is before its start wraps the new year. */
type MonthDay = readonly [month: number, day: number];

export const SEASON_WINDOWS: Record<
  SeasonalLook,
  { from: MonthDay; to: MonthDay }
> = {
  // Dia das Bruxas is 31 October; Finados is 2 November.
  halloween: { from: [10, 1], to: [11, 2] },
  // Through Dia de Reis.
  christmas: { from: [12, 1], to: [1, 6] },
};

/**
 * QA override, per browser: `localStorage.setItem("pqp:season", "christmas")`
 * puts this browser in that season, `"none"` in no season. Remove the key to
 * follow the calendar again.
 */
export const SEASON_OVERRIDE_KEY = "pqp:season";

export function isSeasonalLook(
  look: AppearancePreference,
): look is SeasonalLook {
  return look === "halloween" || look === "christmas";
}

function readOverride(
  storage: Pick<Storage, "getItem"> | null,
): SeasonalLook | "none" | null {
  try {
    const raw = storage?.getItem(SEASON_OVERRIDE_KEY) ?? null;
    return raw === "halloween" || raw === "christmas" || raw === "none"
      ? raw
      : null;
  } catch {
    return null;
  }
}

function inWindow(look: SeasonalLook, now: Date): boolean {
  const { from, to } = SEASON_WINDOWS[look];
  const today = (now.getMonth() + 1) * 100 + now.getDate();
  const start = from[0] * 100 + from[1];
  const end = to[0] * 100 + to[1];
  return start <= end
    ? today >= start && today <= end
    : today >= start || today <= end;
}

/** The seasonal look whose season it is, if any. Windows never overlap. */
export function currentSeason(
  now: Date = new Date(),
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): SeasonalLook | null {
  const override = readOverride(storage);
  if (override) {
    return override === "none" ? null : override;
  }
  return SEASONAL_LOOKS.find((look) => inWindow(look, now)) ?? null;
}

/**
 * Whether the picker lists a look. Every year-round look always; a seasonal
 * one in its season, or while it is the look on screen.
 */
export function isLookOffered(
  look: AppearancePreference,
  current: AppearancePreference,
  season: SeasonalLook | null,
): boolean {
  return !isSeasonalLook(look) || look === season || look === current;
}

/**
 * The year a season belongs to, for the card's once-per-season key. Christmas
 * on 3 January is still last year's Christmas.
 */
export function seasonYear(look: SeasonalLook, now: Date = new Date()): number {
  const { from } = SEASON_WINDOWS[look];
  return now.getMonth() + 1 < from[0] ? now.getFullYear() - 1 : now.getFullYear();
}

export function seasonalHintKey(look: SeasonalLook, now: Date = new Date()): string {
  return `pqp:seasonal-look-${look}-${seasonYear(look, now)}`;
}

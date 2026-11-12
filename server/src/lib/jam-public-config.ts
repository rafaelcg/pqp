import { JAM_PUBLIC_ERRORS } from "@pqp/shared";
import { isEnabled } from "./flags.js";

/**
 * Public jams' switches and numbers (docs/JAM_PUBLIC.md). The flag is the
 * runtime flag `jam_public` (global, default off, `JAM_PUBLIC` as its
 * environment default), read per request so the operator's switch is answered
 * by the very next call on every machine (`lib/flags.ts`, "Caching and the
 * cluster"). The numbers are environment only and read per call, so a test
 * (or an operator restarting with a new value) never races an import.
 */
export function jamPublicEnabled(): boolean {
  return isEnabled("jam_public");
}

/** The `error` token of a write refused while the flag is off. */
export const JAM_PUBLIC_OFF = JAM_PUBLIC_ERRORS.off;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Every tunable, with its default. Exported as one object so the doc, the
 * metrics and the tests read the same names.
 */
export const jamPublicLimits = {
  /** An account younger than this publishes and records through review. */
  minAccountAgeHours: () => envInt("JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS", 72, 0, 24 * 365),
  /** Songs a person may make public per 24 hours (first publishes only). */
  songsPerDay: () => envInt("JAM_PUBLIC_SONGS_PER_DAY", 5, 1, 1000),
  /** Takes a person may record on public songs per 24 hours. */
  takesPerDay: () => envInt("JAM_PUBLIC_TAKES_PER_DAY", 30, 1, 10_000),
  /** Likes (and unlikes) a person may send per minute. */
  likesPerMinute: () => envInt("JAM_PUBLIC_LIKES_PER_MINUTE", 30, 1, 10_000),
  /** Public jam reports a person may file per 24 hours. */
  reportsPerDay: () => envInt("JAM_PUBLIC_REPORTS_PER_DAY", 20, 1, 1000),
  /** Distinct reporters inside the window that hide a song until reviewed. */
  reportsToHide: () => envInt("JAM_PUBLIC_REPORTS_TO_HIDE", 3, 1, 1000),
  /** The auto-hide window, hours. */
  reportWindowHours: () => envInt("JAM_PUBLIC_REPORT_WINDOW_HOURS", 24, 1, 24 * 30),
};

import type { BlogLocale } from "./posts";

function utcStamp(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function formatUtc(
  iso: string,
  locale: BlogLocale,
  options: Intl.DateTimeFormatOptions,
): string {
  const at = utcStamp(iso);
  if (at === null) {
    return iso;
  }
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    at,
  );
}

/**
 * A post's `YYYY-MM-DD` as a readable date, in the reader's language.
 *
 * PARSED AS UTC ON PURPOSE. `new Date("2026-08-21")` is midnight UTC, and
 * formatting that with a local time zone renders the 20th for every reader west
 * of Greenwich, which is most of Brazil. The parts are pulled apart and fed to
 * `Date.UTC`, and the formatter is pinned to UTC, so a post dated the 21st says
 * the 21st everywhere. A release note is dated by the day it shipped, not by
 * where it is being read.
 *
 * Returns the raw string for anything that is not a date, which is what makes
 * this safe to call on data that only a test would ever get wrong.
 */
export function formatPostDate(iso: string, locale: BlogLocale): string {
  return formatUtc(iso, locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Compact date for a list of notes: day and month, no year. */
export function formatPostShortDate(iso: string, locale: BlogLocale): string {
  return formatUtc(iso, locale, {
    day: "numeric",
    month: "short",
  });
}

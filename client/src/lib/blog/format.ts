import type { BlogLocale } from "./posts";

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
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return iso;
  }
  const [, year, month, day] = match;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
}

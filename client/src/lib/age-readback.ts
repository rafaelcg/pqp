import { parseCalendarDate } from "@pqp/shared";
import { intlLocale, type Locale } from "@/lib/locale";

/**
 * A date of birth, spelled out, for the age gate's read-back step ("3 de
 * dezembro de 2008"). Null when `isoDate` is not a real calendar date, which is
 * what lets the caller refuse "31 February" without a request: `new Date` would
 * quietly turn it into 3 March and the read-back would then confirm a date the
 * person never typed.
 *
 * The date is built in UTC and formatted in UTC. A date of birth is a calendar
 * fact with no zone (see `CalendarDate`), so the formatter must not be allowed
 * to apply one: formatted in the viewer's zone, a west-of-UTC reader would be
 * told the day before. No clock is read; nothing here decides anything, it only
 * says back what was typed.
 */
export function formatBirthDateInWords(
  isoDate: string,
  locale: Locale,
): string | null {
  const dob = parseCalendarDate(isoDate);
  if (!dob) {
    return null;
  }
  const instant = new Date(Date.UTC(dob.year, dob.month - 1, dob.day));
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(instant);
  } catch {
    return null;
  }
}

import { MINIMUM_AGE_YEARS } from "./api.js";

/**
 * The calendar half of the 18+ gate, shared so the server and a signed-out
 * browser compute adulthood with the same code.
 *
 * The server's gate (`server/src/services/age-gate.ts`) imports these and
 * decides for an account. The signed-out live preview
 * (`client/src/lib/live-preview.ts`) runs the same comparison on the visitor's
 * own device and never sends the date anywhere: there is no account to record
 * it on, and keeping it on the device is what lets the preview store nothing
 * personal.
 */

// ------------------------------------------------------------- calendar dates

/**
 * A date with no instant attached: year, month (1-12), day (1-31).
 *
 * Not a `Date`. A date of birth is a calendar fact, and the moment one becomes
 * a `Date` it acquires a timezone it never had, which is the whole source of
 * the classic bug where a millisecond subtraction refuses somebody on their own
 * eighteenth birthday because the two operands were resolved in different
 * zones. Every comparison in this file is integer arithmetic on these three
 * fields, so there is nothing for a zone to shift.
 */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Rows earlier than this are a typo, not a person. */
const EARLIEST_PLAUSIBLE_YEAR = 1900;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
}

/**
 * Parse `YYYY-MM-DD`, or null when it is not a real date.
 *
 * Strict on purpose: `new Date("2007-02-30")` silently becomes 2 March, so a
 * date that does not exist would be accepted and then compared as some *other*
 * date. Doing the field validation by hand is what makes an impossible input a
 * rejected input rather than a quietly relocated one.
 */
export function parseCalendarDate(value: string): CalendarDate | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

export function formatCalendarDate(date: CalendarDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/** Negative when `a` is earlier, positive when later, zero when the same day. */
function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * The largest UTC offset any inhabited place uses (UTC+14, the Line Islands).
 *
 * Used to answer "what is the latest calendar date it can be for anybody right
 * now", which is what `today` has to mean here. The asymmetry is deliberate and
 * is the single most important line in this file:
 *
 *   Refusing somebody is PERMANENT. Admitting somebody up to one day early is
 *   not. So where the answer depends on which side of midnight a clock is on,
 *   the gate resolves it in favour of the person.
 *
 * Taking the date from the client instead would be exact, and worthless: a
 * clock is the one input the person being gated fully controls. Taking plain
 * UTC would be honest and wrong: an eighteen-year-old in Kiribati typing their
 * real date of birth on the morning of their birthday is still "yesterday" in
 * UTC, and this gate would block their account forever over a timezone. So the
 * boundary is generous by at most one day, and the tests below pin exactly
 * that: the pure comparison is strict to the day, and the definition of "today"
 * is what carries the grace.
 */
const MAX_UTC_OFFSET_MINUTES = 14 * 60;

/**
 * The latest calendar date in use anywhere on Earth at `now`. See
 * `MAX_UTC_OFFSET_MINUTES` for why this, and not the server's own date.
 */
export function ageCheckToday(now: Date = new Date()): CalendarDate {
  const shifted = new Date(now.getTime() + MAX_UTC_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Has somebody born on `dob` reached `years` years old by `today`?
 *
 * Pure integer comparison of (birth year + years, birth month, birth day)
 * against today. That makes 29 February fall out correctly without a special
 * case: a leap-day child's eighteenth anniversary is 2026-02-29, a date that
 * does not exist, and comparing it against a real date puts the boundary on
 * 1 March, which is also what Brazilian civil law says (CC art. 132 §3: a term
 * with no exactly corresponding day expires on the day immediately following).
 * 28 February compares as earlier, so they are not yet eighteen on it.
 */
export function isAtLeastYearsOld(
  dob: CalendarDate,
  today: CalendarDate,
  years: number = MINIMUM_AGE_YEARS,
): boolean {
  const anniversary: CalendarDate = {
    year: dob.year + years,
    month: dob.month,
    day: dob.day,
  };
  return compareDates(anniversary, today) <= 0;
}

/**
 * Is this a date a living person could have been born on?
 *
 * A date in the future or before 1900 is a slip of the keyboard, not a
 * declaration, and must therefore NOT consume the account's single attempt:
 * see `recordAgeDeclaration`. Rejecting it as malformed input and letting the
 * user type again is safe precisely because neither answer helps somebody
 * probing for a passing value: any *plausible* date they enter is final.
 */
export function isPlausibleBirthDate(
  dob: CalendarDate,
  today: CalendarDate = ageCheckToday(),
): boolean {
  return dob.year >= EARLIEST_PLAUSIBLE_YEAR && compareDates(dob, today) <= 0;
}

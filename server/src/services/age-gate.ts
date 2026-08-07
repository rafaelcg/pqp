import { MINIMUM_AGE_YEARS, type AgeGateStatus } from "@pqp/shared";
import { getPool } from "../db.js";

export type { AgeGateStatus };

/**
 * The 18+ gate.
 *
 * The model is deliberately narrow and it is worth stating plainly, because
 * every design decision below follows from it:
 *
 *   The user types a date of birth, once. The server decides. There is no
 *   second attempt, and no self-serve way back from a refusal.
 *
 * It is NOT identity verification, and nothing here should grow into it — the
 * Terms say plainly that age is self-declared and unverified, and that sentence
 * has to stay true. What this buys is a meaningful declaration (a date, entered
 * neutrally, not a "yes I am 18" button nobody reads) that cannot be walked
 * back the instant it produces the wrong answer. A gate you can retry is a gate
 * that does nothing.
 */

// ------------------------------------------------------------- calendar dates

/**
 * A date with no instant attached: year, month (1-12), day (1-31).
 *
 * Not a `Date`. A date of birth is a calendar fact, and the moment one becomes
 * a `Date` it acquires a timezone it never had — which is the whole source of
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
 * Taking the date from the client instead would be exact, and worthless — a
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
 * 1 March — which is also what Brazilian civil law says (CC art. 132 §3: a term
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
 * declaration, and must therefore NOT consume the account's single attempt —
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

// ------------------------------------------------------------------- storage

interface AgeCheckRow {
  age_checked_at: Date | null;
  age_check_passed: boolean | null;
}

function statusOf(row: AgeCheckRow | undefined): AgeGateStatus {
  if (!row || row.age_checked_at === null) {
    return "pending";
  }
  return row.age_check_passed ? "passed" : "blocked";
}

/**
 * Where this account stands, read fresh from the database on every call.
 *
 * Deliberately not carried on the session user the way `email_domains` and the
 * handle are. `resolveDbUser` caches that row for 30 seconds to avoid an UPDATE
 * per request, and a value read off it would keep answering with the state the
 * account had when it was cached — for the one flag that decides whether the
 * account may be in the product at all. Two cases make that unacceptable rather
 * than merely untidy: an operator blocking an account by hand needs it to take
 * effect now, and a user who has just declared their date of birth needs their
 * very next request to succeed rather than to fail for another half minute.
 *
 * The cost is one primary-key lookup per authenticated request. `/api/me`
 * already issues three. This is the same trade `getDmPrivacy` makes, for the
 * same reason.
 */
export async function getAgeGateStatus(userId: string): Promise<AgeGateStatus> {
  const result = await getPool().query<AgeCheckRow>(
    `SELECT age_checked_at, age_check_passed FROM users WHERE id = $1`,
    [userId],
  );
  return statusOf(result.rows[0]);
}

export interface AgeDeclarationResult {
  /** False when the account had already answered — see below. */
  recorded: boolean;
  status: AgeGateStatus;
}

/**
 * Record the one declaration this account gets.
 *
 * `WHERE age_checked_at IS NULL` is the entire no-retry rule, and it is in the
 * UPDATE rather than in a read-then-write for a reason: two requests racing
 * with two different dates would both pass a prior `SELECT`, and the second
 * write would overwrite the first — which is retry-until-pass with an extra
 * step. Postgres decides here, once.
 *
 * The date itself is written only when the declaration fails. For a pass the
 * column stays NULL, because the answer has already been reduced to a boolean
 * and the date is no longer needed for anything — see the note in schema.sql.
 *
 * A caller that loses the race gets `recorded: false` and the status that
 * actually stands, so the route can say "already answered" rather than pretend
 * the second date was accepted.
 */
export async function recordAgeDeclaration(
  userId: string,
  dob: CalendarDate,
  today: CalendarDate = ageCheckToday(),
): Promise<AgeDeclarationResult> {
  const passed = isAtLeastYearsOld(dob, today);
  const result = await getPool().query<AgeCheckRow>(
    `UPDATE users
        SET age_checked_at = NOW(),
            age_check_passed = $2,
            age_check_dob = $3
      WHERE id = $1 AND age_checked_at IS NULL
      RETURNING age_checked_at, age_check_passed`,
    [userId, passed, passed ? null : formatCalendarDate(dob)],
  );

  const row = result.rows[0];
  if (!row) {
    return { recorded: false, status: await getAgeGateStatus(userId) };
  }
  return { recorded: true, status: statusOf(row) };
}

// ---------------------------------------------------------------- exemptions

/**
 * The routes an account that has not passed the gate may still reach.
 *
 * Kept as one explicit list rather than a prefix rule, because "which doors
 * stay open to somebody we are refusing" is a decision that should have to be
 * made deliberately, one route at a time, and be readable in one place.
 *
 * There are exactly two reasons to be on it:
 *
 *  1. Answering the gate at all. `GET /api/me` is how the client learns the
 *     status, and `POST /api/me/age-check` is the declaration itself. Without
 *     both, a pending account cannot get anywhere, including out.
 *
 *  2. LGPD art. 18. A blocked account is still a data subject: the rights to
 *     deletion (VI) and to portability (V) do not depend on being welcome. The
 *     alternative is a person who is locked out of the product AND locked away
 *     from their own data, which converts a safety measure into a data-rights
 *     violation.
 *
 * Nothing that reads, writes or reaches another user belongs here. Note in
 * particular that `PATCH /api/me` is absent: a refused account has no business
 * changing the name other people would see.
 */
const AGE_GATE_EXEMPT: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/api/me" },
  { method: "POST", path: "/api/me/age-check" },
  // LGPD art. 18, VI — erasure. Owned by the account-deletion work stream; if
  // that route is ever renamed, it has to be renamed here too or a blocked user
  // loses the right along with the access.
  { method: "DELETE", path: "/api/me" },
  // LGPD art. 18, V — portability.
  { method: "GET", path: "/api/me/export" },
];

export function isAgeGateExempt(method: string, pathname: string): boolean {
  return AGE_GATE_EXEMPT.some(
    (route) => route.method === method && route.path === pathname,
  );
}

/**
 * What a refused caller is told. Two different sentences because they are two
 * different situations, and the second one is read by somebody who has just
 * been told they cannot use the product — it should not read as an accusation.
 */
export const AGE_GATE_PENDING_MESSAGE =
  `Confirm your date of birth to continue. pqp is for people aged ` +
  `${MINIMUM_AGE_YEARS} and over.`;

export const AGE_GATE_BLOCKED_MESSAGE =
  `This account cannot be used. The date of birth on file is under ` +
  `${MINIMUM_AGE_YEARS}.`;

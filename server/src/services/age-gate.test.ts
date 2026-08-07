import { describe, expect, it } from "vitest";
import {
  ageCheckToday,
  formatCalendarDate,
  isAgeGateExempt,
  isAtLeastYearsOld,
  isPlausibleBirthDate,
  parseCalendarDate,
  type CalendarDate,
} from "./age-gate.js";

/**
 * The boundary arithmetic, tested without a database and without a clock.
 *
 * `isAtLeastYearsOld` takes `today` explicitly precisely so these cases can be
 * stated as calendar facts rather than as "run this on the right day". The one
 * function that does read the clock — `ageCheckToday` — is pinned separately at
 * the bottom, because what it returns is a policy decision and not arithmetic.
 */

function date(value: string): CalendarDate {
  const parsed = parseCalendarDate(value);
  if (!parsed) {
    throw new Error(`test wrote an impossible date: ${value}`);
  }
  return parsed;
}

describe("age boundary", () => {
  it("admits somebody who turns 18 today", () => {
    expect(isAtLeastYearsOld(date("2008-03-10"), date("2026-03-10"))).toBe(true);
  });

  it("refuses somebody who turns 18 tomorrow", () => {
    expect(isAtLeastYearsOld(date("2008-03-10"), date("2026-03-09"))).toBe(
      false,
    );
  });

  it("admits somebody a day past their eighteenth birthday", () => {
    expect(isAtLeastYearsOld(date("2008-03-10"), date("2026-03-11"))).toBe(true);
  });

  it("refuses a seventeen-year-old by a whole year", () => {
    expect(isAtLeastYearsOld(date("2009-03-10"), date("2026-03-10"))).toBe(
      false,
    );
  });

  /**
   * 29 February 2008 + 18 years is 29 February 2026, a date that does not
   * exist. Brazilian civil law (CC art. 132 §3) resolves a term with no
   * corresponding day onto the day immediately after, so the eighteenth
   * birthday falls on 1 March. The tuple comparison produces that on its own —
   * these two cases exist to make sure it stays that way if anybody rewrites
   * the comparison.
   */
  it("puts a 29 February birthday on 1 March in a non-leap year", () => {
    expect(isAtLeastYearsOld(date("2008-02-29"), date("2026-02-28"))).toBe(
      false,
    );
    expect(isAtLeastYearsOld(date("2008-02-29"), date("2026-03-01"))).toBe(true);
  });

  it("uses the real 29 February when the anniversary year has one", () => {
    // 2004 + 18 = 2022, no 29 Feb; 2004 + 20 = 2024, which has one.
    expect(isAtLeastYearsOld(date("2004-02-29"), date("2024-02-29"), 20)).toBe(
      true,
    );
    expect(isAtLeastYearsOld(date("2004-02-29"), date("2024-02-28"), 20)).toBe(
      false,
    );
  });

  it("handles a 31 December birthday across the year boundary", () => {
    expect(isAtLeastYearsOld(date("2007-12-31"), date("2025-12-30"))).toBe(
      false,
    );
    expect(isAtLeastYearsOld(date("2007-12-31"), date("2025-12-31"))).toBe(true);
    expect(isAtLeastYearsOld(date("2007-12-31"), date("2026-01-01"))).toBe(true);
  });

  it("handles a 1 January birthday", () => {
    expect(isAtLeastYearsOld(date("2008-01-01"), date("2025-12-31"))).toBe(
      false,
    );
    expect(isAtLeastYearsOld(date("2008-01-01"), date("2026-01-01"))).toBe(true);
  });
});

describe("date parsing", () => {
  it("accepts a real date", () => {
    expect(parseCalendarDate("1990-07-04")).toEqual({
      year: 1990,
      month: 7,
      day: 4,
    });
  });

  it("accepts 29 February in a leap year and refuses it otherwise", () => {
    expect(parseCalendarDate("2008-02-29")).not.toBeNull();
    expect(parseCalendarDate("2007-02-29")).toBeNull();
    // 1900 is divisible by 4 but not a leap year.
    expect(parseCalendarDate("1900-02-29")).toBeNull();
    expect(parseCalendarDate("2000-02-29")).not.toBeNull();
  });

  /**
   * The reason this is hand-rolled: `new Date("2007-02-30")` is 2 March, so a
   * parser built on Date would accept a date nobody was born on and then
   * compare it as a different one.
   */
  it("refuses a day the month does not have", () => {
    expect(parseCalendarDate("2007-02-30")).toBeNull();
    expect(parseCalendarDate("2007-04-31")).toBeNull();
    expect(parseCalendarDate("2007-13-01")).toBeNull();
    expect(parseCalendarDate("2007-00-10")).toBeNull();
    expect(parseCalendarDate("2007-01-00")).toBeNull();
  });

  it("refuses anything that is not YYYY-MM-DD", () => {
    for (const bad of [
      "",
      "1990-7-4",
      "07/04/1990",
      "1990-07-04T00:00:00Z",
      "not-a-date",
      "19900704",
    ]) {
      expect(parseCalendarDate(bad)).toBeNull();
    }
  });

  it("round-trips through the stored format", () => {
    expect(formatCalendarDate(date("2008-02-29"))).toBe("2008-02-29");
    expect(formatCalendarDate({ year: 1990, month: 7, day: 4 })).toBe(
      "1990-07-04",
    );
  });
});

describe("plausibility", () => {
  const today = date("2026-03-10");

  it("refuses a date in the future", () => {
    expect(isPlausibleBirthDate(date("2026-03-11"), today)).toBe(false);
    expect(isPlausibleBirthDate(date("2030-01-01"), today)).toBe(false);
  });

  it("accepts today itself — a newborn is implausible, not impossible", () => {
    expect(isPlausibleBirthDate(today, today)).toBe(true);
  });

  it("refuses a year that is a typo rather than a person", () => {
    expect(isPlausibleBirthDate(date("0208-03-10"), today)).toBe(false);
    expect(isPlausibleBirthDate(date("1899-12-31"), today)).toBe(false);
    expect(isPlausibleBirthDate(date("1900-01-01"), today)).toBe(true);
  });
});

describe("today, as the gate defines it", () => {
  /**
   * Deliberately the latest date in use anywhere, not the server's own. The
   * failure this avoids is permanent: somebody in UTC+13/+14 typing their real
   * date of birth on the morning of their eighteenth birthday, while UTC still
   * reads yesterday, would otherwise be blocked forever over a timezone.
   */
  it("is tomorrow's UTC date once UTC+14 has crossed midnight", () => {
    // 2026-03-09T23:00Z is already 2026-03-10 in the Line Islands.
    expect(ageCheckToday(new Date("2026-03-09T23:00:00Z"))).toEqual({
      year: 2026,
      month: 3,
      day: 10,
    });
  });

  it("is the UTC date for most of the UTC day", () => {
    expect(ageCheckToday(new Date("2026-03-10T00:00:00Z"))).toEqual({
      year: 2026,
      month: 3,
      day: 10,
    });
    expect(ageCheckToday(new Date("2026-03-10T09:59:00Z"))).toEqual({
      year: 2026,
      month: 3,
      day: 10,
    });
  });

  it("costs at most one day of generosity at the boundary", () => {
    // Somebody who turns 18 on 2026-03-10 declaring at 23:00Z on the 9th.
    const now = new Date("2026-03-09T23:00:00Z");
    expect(isAtLeastYearsOld(date("2008-03-10"), ageCheckToday(now))).toBe(true);
    // Two days short is refused whatever the timezone.
    expect(isAtLeastYearsOld(date("2008-03-11"), ageCheckToday(now))).toBe(
      false,
    );
  });
});

describe("exempt routes", () => {
  it("lets a refused account read its own status and answer the question", () => {
    expect(isAgeGateExempt("GET", "/api/me")).toBe(true);
    expect(isAgeGateExempt("POST", "/api/me/age-check")).toBe(true);
  });

  it("keeps the LGPD art. 18 routes open", () => {
    expect(isAgeGateExempt("DELETE", "/api/me")).toBe(true);
    expect(isAgeGateExempt("GET", "/api/me/export")).toBe(true);
  });

  it("matches on the method too, not just the path", () => {
    expect(isAgeGateExempt("PATCH", "/api/me")).toBe(false);
    expect(isAgeGateExempt("POST", "/api/me")).toBe(false);
    expect(isAgeGateExempt("GET", "/api/me/age-check")).toBe(false);
  });

  it("exempts nothing else", () => {
    for (const path of [
      "/api/servers",
      "/api/dms",
      "/api/me/preferences",
      "/api/ice-servers",
      "/api/users/search",
      "/api/me/",
      "/api/me/export/all",
    ]) {
      expect(isAgeGateExempt("GET", path)).toBe(false);
    }
  });
});

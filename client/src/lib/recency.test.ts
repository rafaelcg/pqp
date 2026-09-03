import { describe, expect, it } from "vitest";
import { formatRecency } from "./utils";

/**
 * The conversation-row stamp must never let an old thread pass for today's.
 */
function daysAgo(days: number, hour = 14): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 5, 0, 0);
  return d.toISOString();
}

describe("formatRecency", () => {
  it("is a time only for today", () => {
    expect(formatRecency(daysAgo(0), "en-US")).toMatch(/\d{1,2}:\d{2}/);
  });

  it("says yesterday for yesterday, never a bare time", () => {
    const label = formatRecency(daysAgo(1), "en-US");
    expect(label).toBe("Yesterday");
    expect(label).not.toMatch(/\d:\d{2}/);
  });

  it("names the weekday inside a week", () => {
    const label = formatRecency(daysAgo(3), "en-US");
    expect(label).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
  });

  it("uses a short date beyond a week, with the year only when it differs", () => {
    expect(formatRecency(daysAgo(20), "en-US")).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(formatRecency("2021-03-04T10:00:00.000Z", "en-US")).toMatch(/21/);
  });
});

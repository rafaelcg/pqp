import { describe, expect, it } from "vitest";
import { formatPostDate, formatPostShortDate } from "./format";

describe("formatPostDate", () => {
  it("renders the day it shipped, not the day the reader's clock says", () => {
    // The bug this exists to stop: `new Date("2026-08-21")` is midnight UTC,
    // and formatting it in São Paulo renders the 20th. Every Brazilian reader
    // would have seen every release note dated a day early.
    expect(formatPostDate("2026-08-21", "pt-BR")).toContain("21");
    expect(formatPostDate("2026-08-21", "en")).toContain("21");
  });

  it("writes the month in the reader's language", () => {
    expect(formatPostDate("2026-08-21", "pt-BR").toLowerCase()).toContain(
      "agosto",
    );
    expect(formatPostDate("2026-08-21", "en").toLowerCase()).toContain("august");
  });

  it("hands back anything that is not a date untouched", () => {
    expect(formatPostDate("nonsense", "en")).toBe("nonsense");
    expect(formatPostDate("2026-8-1", "en")).toBe("2026-8-1");
  });

  it("short form keeps the shipped day and drops the year", () => {
    expect(formatPostShortDate("2026-08-21", "en")).toMatch(/21/);
    expect(formatPostShortDate("2026-08-21", "en").toLowerCase()).toMatch(/aug/);
    expect(formatPostShortDate("2026-08-21", "en")).not.toMatch(/2026/);
    expect(formatPostShortDate("2026-08-21", "pt-BR")).toMatch(/21/);
  });
});

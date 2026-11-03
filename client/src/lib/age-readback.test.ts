import { describe, expect, it } from "vitest";
import { formatBirthDateInWords } from "./age-readback";

describe("formatBirthDateInWords", () => {
  it("spells the date out in each language", () => {
    expect(formatBirthDateInWords("2008-12-03", "en")).toBe("December 3, 2008");
    expect(formatBirthDateInWords("2008-12-03", "pt-BR")).toBe(
      "3 de dezembro de 2008",
    );
    expect(formatBirthDateInWords("2008-12-03", "es")).toBe(
      "3 de diciembre de 2008",
    );
  });

  it("does not move the day with the reader's time zone", () => {
    // The first and last days of a year are where a zone shift shows.
    expect(formatBirthDateInWords("2000-01-01", "en")).toBe("January 1, 2000");
    expect(formatBirthDateInWords("1999-12-31", "pt-BR")).toBe(
      "31 de dezembro de 1999",
    );
  });

  it("refuses a day the month does not have instead of moving it", () => {
    // `new Date(2008, 1, 31)` is 2 March: reading that back would confirm a
    // date nobody typed.
    expect(formatBirthDateInWords("2008-02-31", "en")).toBeNull();
    expect(formatBirthDateInWords("2007-02-29", "en")).toBeNull();
    expect(formatBirthDateInWords("2008-02-29", "en")).toBe("February 29, 2008");
  });
});

import { describe, expect, it } from "vitest";
import { ageLabel, relativeAge } from "./live-status";

/**
 * `relativeAge` hands the words to `Intl.RelativeTimeFormat`, and ICU data
 * differs between Node and browser versions (a space can be a plain one, a
 * no-break space U+00A0 or a narrow one U+202F; "min." can lose its dot).
 * So each case pins the number and the start of the unit with a loose
 * pattern (`\s` matches all three spaces), never the whole string.
 */
const NOW = new Date("2026-10-17T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe("relativeAge", () => {
  it("says now under a minute, in each language", () => {
    expect(relativeAge(ago(0), "en", NOW)).toMatch(/now/i);
    expect(relativeAge(ago(42), "en", NOW)).toMatch(/now/i);
    expect(relativeAge(ago(42), "pt-BR", NOW)).toMatch(/agora/i);
    expect(relativeAge(ago(42), "es", NOW)).toMatch(/ahora/i);
  });

  it("treats a reading from the future as now", () => {
    expect(relativeAge(ago(-300), "en", NOW)).toMatch(/now/i);
  });

  it("counts minutes", () => {
    for (const locale of ["en", "pt-BR", "es"]) {
      expect(relativeAge(ago(3 * 60), locale, NOW), locale).toMatch(/3\s*min/i);
    }
    expect(relativeAge(ago(3 * 60), "en", NOW)).toMatch(/ago/i);
    expect(relativeAge(ago(3 * 60), "pt-BR", NOW)).toMatch(/há/i);
    expect(relativeAge(ago(3 * 60), "es", NOW)).toMatch(/hace/i);
  });

  it("counts hours from 60 minutes on", () => {
    for (const locale of ["en", "pt-BR", "es"]) {
      const text = relativeAge(ago(2 * 3600), locale, NOW);
      expect(text, locale).toMatch(/2\s*h/i);
      expect(text, locale).not.toMatch(/min/i);
    }
  });

  it("counts days from 24 hours on", () => {
    for (const locale of ["en", "pt-BR", "es"]) {
      expect(relativeAge(ago(3 * 86400), locale, NOW), locale).toMatch(/3\s*d/i);
    }
  });
});

describe("ageLabel", () => {
  it("stays the pt-BR label the concept previews use", () => {
    expect(ageLabel(null, NOW)).toBe("sem horário");
    expect(ageLabel(ago(10), NOW)).toBe("agora há pouco");
    expect(ageLabel(ago(3 * 60), NOW)).toBe("há 3 min");
    expect(ageLabel(ago(2 * 3600), NOW)).toBe("há 2 h");
  });
});

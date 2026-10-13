import { describe, expect, it } from "vitest";
import { soundboardNameProblem, soundboardNameSchema } from "./soundboard.js";

/*
 * The name rule must agree with the database check
 * (`char_length(name) BETWEEN 2 AND 24`, which counts code points). It did
 * not: "🎺" is two UTF-16 units, passed the schema, and failed the insert
 * with a 500.
 */
describe("soundboard clip names", () => {
  it("counts characters the way Postgres does", () => {
    expect(soundboardNameProblem("🎺")).toBe("length");
    expect(soundboardNameSchema.safeParse("🎺").success).toBe(false);
    expect(soundboardNameProblem("🎺🎺")).toBeNull();
    expect(soundboardNameProblem("a".repeat(24))).toBeNull();
    expect(soundboardNameProblem("🎺".repeat(24))).toBeNull();
    expect(soundboardNameProblem("🎺".repeat(25))).toBe("length");
  });

  it("keeps emoji joined with ZWJ and variation selectors", () => {
    expect(soundboardNameProblem("👨‍👩‍👧 festa")).toBeNull();
    expect(soundboardNameProblem("❤️ ok")).toBeNull();
  });

  it("refuses names that are blank or render as other text", () => {
    expect(soundboardNameProblem("​​")).toBe("hidden");
    expect(soundboardNameProblem("a‮b‮c")).toBe("hidden");
    expect(soundboardNameProblem("ab⁦cd")).toBe("hidden");
    expect(soundboardNameProblem("ab﻿")).toBe("hidden");
  });

  it("refuses fillers, blanks, control and tag characters", () => {
    const hidden = [
      "\u3164\u3164", // U+3164 Hangul filler
      "\u115f\u1160", // U+115F U+1160
      "\uffa0\uffa0", // U+FFA0
      "\u2800\u2800", // U+2800 Braille blank
      "ab\tcd",
      "ab\ncd",
      "ab\u0007cd",
      "ab\u007fcd",
      "ab\u0085cd",
      "a\u{E0041}\u{E0042}",
      "\u{E0001}\u{E007F}",
      "ab\u00adcd",
      "ab\u061ccd",
    ];
    for (const name of hidden) {
      expect(soundboardNameProblem(name), JSON.stringify(name)).toBe("hidden");
      expect(soundboardNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("does not let a filler stand in for the visible character", () => {
    // Two of them are long enough and are letters to Unicode, and still hide.
    expect(soundboardNameProblem("\u3164\u3164\u3164")).toBe("hidden");
    expect(soundboardNameProblem("\u2800 \u2800")).toBe("hidden");
    // A real name beside them is refused too, not quietly accepted.
    expect(soundboardNameProblem("ab\u3164")).toBe("hidden");
  });

  it("still accepts ordinary names, Hangul and Braille patterns", () => {
    expect(soundboardNameProblem("안녕하세요")).toBeNull();
    expect(soundboardNameProblem("Grito 2")).toBeNull();
    expect(soundboardNameProblem("⠁⠃⠉")).toBeNull();
    expect(soundboardNameProblem("ação")).toBeNull();
  });

  it("trims before measuring", () => {
    expect(soundboardNameSchema.parse("  Buzina  ")).toBe("Buzina");
    expect(soundboardNameSchema.safeParse("  a  ").success).toBe(false);
  });

  it("refuses separators and the rarer format controls", () => {
    // Line and paragraph separators, deprecated format controls, the
    // interlinear annotation marks and the shorthand format controls.
    for (const hidden of ["\u2028", "\u2029", "\u206A", "\u206F", "\uFFF9", "\u{1BCA0}"]) {
      expect(soundboardNameProblem(`ab${hidden}cd`), JSON.stringify(hidden)).toBe("hidden");
    }
  });
});

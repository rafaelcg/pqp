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

  it("trims before measuring", () => {
    expect(soundboardNameSchema.parse("  Buzina  ")).toBe("Buzina");
    expect(soundboardNameSchema.safeParse("  a  ").success).toBe(false);
  });
});

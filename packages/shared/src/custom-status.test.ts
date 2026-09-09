import { describe, expect, it } from "vitest";
import {
  CUSTOM_STATUS_MAX_LENGTH,
  customStatusLength,
  customStatusSchema,
  normalizeCustomStatus,
  validateCustomStatus,
} from "./status.js";

/**
 * O recado, pinned at the properties the feature depends on rather than at
 * "the schema parses a string".
 *
 * Each block below is a way this field could quietly become something other
 * than a one-line status somebody wrote:
 *
 *   * A SECOND LINE. The member list row must never wrap, so a pasted
 *     signature has to arrive as one line rather than as an error, and never
 *     as a stored newline no surface can draw.
 *   * A CAP THAT COUNTS THE WRONG THING. This field is mostly emoji, and a cap
 *     counted in UTF-16 units halves itself for exactly that content.
 *   * AN INVISIBLE PAYLOAD. Eighty non-breaking spaces is a blank row that
 *     pushes every name below it down; a bidi override reorders them.
 *   * TWO SPELLINGS OF EMPTY. Whitespace has to normalise to the same thing an
 *     untouched field produces, or every client grows two tests for one state.
 *
 * Every invisible character below is written as an escape rather than pasted
 * in. A test whose input cannot be seen in the diff is a test nobody reviews.
 */

/** U+00A0 non-breaking space. Deliberately not matched by `\s`. */
const NBSP = "\u{00a0}";
/** U+200B zero width space: the "empty" status that is not empty. */
const ZWSP = "\u{200b}";
/** U+FEFF byte order mark, as it arrives pasted out of a document. */
const BOM = "\u{feff}";
/** U+202E right-to-left override. */
const RLO = "\u{202e}";
/** U+2066 left-to-right isolate: the same attack, newer spelling. */
const LRI = "\u{2066}";
/** U+200D zero width joiner, which is how a family emoji is spelled. */
const ZWJ = "\u{200d}";

describe("normalizeCustomStatus", () => {
  it("collapses every run of whitespace to one space and trims the ends", () => {
    expect(normalizeCustomStatus("  jogando   valorant  ")).toBe(
      "jogando valorant",
    );
  });

  it("turns a pasted second line into one line rather than refusing it", () => {
    // The row it is drawn in is one line high, so a stored newline would be a
    // value no surface can render honestly.
    expect(normalizeCustomStatus("volto as 22h\nchama no zap")).toBe(
      "volto as 22h chama no zap",
    );
    expect(normalizeCustomStatus("a\tb")).toBe("a b");
    expect(normalizeCustomStatus("a\r\nb")).toBe("a b");
  });

  it("treats the invisible spaces as spaces, so a padded status is empty", () => {
    // None of these three is JavaScript whitespace, and all three are how
    // somebody makes a status that is blank on screen and non-empty to the
    // database.
    expect(normalizeCustomStatus(` ${NBSP}${ZWSP}${BOM}`)).toBe("");
    expect(normalizeCustomStatus(`oi${NBSP} gente`)).toBe("oi gente");
  });

  it("is idempotent", () => {
    const messy = "  no  gym \n ate as 20  ";
    expect(normalizeCustomStatus(normalizeCustomStatus(messy))).toBe(
      normalizeCustomStatus(messy),
    );
  });

  it("leaves an ordinary line alone", () => {
    expect(normalizeCustomStatus("no gym, volto as 20h")).toBe(
      "no gym, volto as 20h",
    );
  });
});

describe("customStatusLength", () => {
  it("counts an emoji as one character, the way the person typing does", () => {
    // The whole reason the cap is not `z.string().max()`: this string is two
    // UTF-16 units and one character.
    expect("\u{1f480}".length).toBe(2);
    expect(customStatusLength("\u{1f480}")).toBe(1);
  });

  it("counts a plain line the obvious way", () => {
    expect(customStatusLength("oi")).toBe(2);
  });
});

describe("validateCustomStatus", () => {
  it("accepts a full line of emoji, which a UTF-16 cap would have halved", () => {
    const skulls = "\u{1f480}".repeat(CUSTOM_STATUS_MAX_LENGTH);
    expect(skulls.length).toBe(CUSTOM_STATUS_MAX_LENGTH * 2);
    expect(validateCustomStatus(skulls)).toBeNull();
  });

  it("refuses one character past the cap", () => {
    expect(
      validateCustomStatus("a".repeat(CUSTOM_STATUS_MAX_LENGTH)),
    ).toBeNull();
    expect(validateCustomStatus("a".repeat(CUSTOM_STATUS_MAX_LENGTH + 1))).toBe(
      "length",
    );
  });

  it("keeps the characters emoji are spelled with", () => {
    // A ZWJ family, then a red heart plus the variation selector that colours
    // it. Refusing either would refuse most of what this field is for.
    expect(
      validateCustomStatus(`\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`),
    ).toBeNull();
    expect(validateCustomStatus("\u{2764}" + "\u{fe0f}")).toBeNull();
  });

  it("refuses a bidi override, which would reorder the names under it", () => {
    expect(validateCustomStatus(`oi${RLO}gente`)).toBe("characters");
    expect(validateCustomStatus(`oi${LRI}gente`)).toBe("characters");
  });

  it("refuses a control character", () => {
    // U+0007 and a newline. Both are reachable only by a caller that skipped
    // normalisation, which is exactly why this is a separate function from it.
    expect(validateCustomStatus(`oi${"\u{0007}"}gente`)).toBe(
      "characters",
    );
    expect(validateCustomStatus("oi\ngente")).toBe("characters");
  });

  it("accepts Portuguese, accents and all", () => {
    expect(validateCustomStatus("não tô afim de nada hoje")).toBeNull();
  });
});

describe("customStatusSchema", () => {
  it("normalises before it measures", () => {
    // A full-length line plus a lot of whitespace. The whitespace is not what
    // the cap is about, so this is accepted rather than refused for length.
    const padded = `   ${"a".repeat(CUSTOM_STATUS_MAX_LENGTH)}   `;
    expect(customStatusSchema.parse(padded)).toBe(
      "a".repeat(CUSTOM_STATUS_MAX_LENGTH),
    );
  });

  it("turns an all-whitespace body into the empty string", () => {
    // Which the server stores as NULL. One spelling of "nothing here".
    expect(customStatusSchema.parse(`  ${NBSP} \n\t   `)).toBe("");
  });

  it("refuses a body long enough to be an attack rather than a typo", () => {
    expect(customStatusSchema.safeParse("a".repeat(50_000)).success).toBe(false);
  });

  it("refuses an over-long line and a bidi override", () => {
    expect(
      customStatusSchema.safeParse("a".repeat(CUSTOM_STATUS_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
    expect(customStatusSchema.safeParse(`oi${RLO}gente`).success).toBe(false);
  });
});

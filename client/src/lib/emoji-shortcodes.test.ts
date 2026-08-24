import { describe, expect, it } from "vitest";
import {
  applyEmojiShortcode,
  expandClosedShortcodeAtCaret,
  expandEmojiShortcodes,
  filterEmojiShortcodes,
  findEmojiQuery,
} from "./emoji-shortcodes";

describe("expandEmojiShortcodes", () => {
  it("replaces known names and leaves unknown ones", () => {
    expect(expandEmojiShortcodes("nice :fire: :nope:")).toBe("nice 🔥 :nope:");
  });
});

describe("findEmojiQuery", () => {
  it("finds a token at a word start", () => {
    expect(findEmojiQuery("hi :fir", 7)).toEqual({
      start: 3,
      end: 7,
      query: "fir",
    });
  });

  it("allows an empty query right after the colon", () => {
    expect(findEmojiQuery(":", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("ignores a colon mid-word and a just-closed shortcode", () => {
    expect(findEmojiQuery("http://x", 7)).toBeNull();
    expect(findEmojiQuery(":fire:", 6)).toBeNull();
  });
});

describe("filterEmojiShortcodes", () => {
  it("matches a prefix and caps the list", () => {
    const matches = filterEmojiShortcodes("th");
    expect(matches.some((entry) => entry.emoji === "👍")).toBe(true);
    expect(filterEmojiShortcodes("").length).toBeLessThanOrEqual(8);
  });

  it("returns one row per glyph even when aliases exist", () => {
    const thumbs = filterEmojiShortcodes("+");
    expect(thumbs.filter((entry) => entry.emoji === "👍")).toHaveLength(1);
  });
});

describe("applyEmojiShortcode", () => {
  it("replaces the token and leaves a trailing space", () => {
    const value = "hi :fir";
    const active = findEmojiQuery(value, 7)!;
    expect(applyEmojiShortcode(value, active, "🔥")).toEqual({
      value: "hi 🔥 ",
      caret: 6,
    });
  });
});

describe("expandClosedShortcodeAtCaret", () => {
  it("expands a completed name at the caret", () => {
    expect(expandClosedShortcodeAtCaret("nice :fire:", 11)).toEqual({
      value: "nice 🔥",
      caret: 7,
    });
  });

  it("leaves unknown names and mid-word colons", () => {
    expect(expandClosedShortcodeAtCaret(":nope:", 6)).toBeNull();
    expect(expandClosedShortcodeAtCaret("see http://x:fire:", 18)).toBeNull();
  });
});

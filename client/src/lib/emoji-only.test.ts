import { describe, expect, it } from "vitest";
import { isJumboEmoji } from "./emoji-only";

describe("isJumboEmoji", () => {
  it("takes one to six emoji with spaces between", () => {
    expect(isJumboEmoji("🔥")).toBe(true);
    expect(isJumboEmoji("🔥🔥🔥")).toBe(true);
    expect(isJumboEmoji(" 👍 🎉 ")).toBe(true);
    expect(isJumboEmoji("❤️")).toBe(true);
  });

  it("counts a joined or skin-toned emoji and a flag as one", () => {
    expect(isJumboEmoji("👨‍👩‍👧‍👦")).toBe(true);
    expect(isJumboEmoji("👍🏽")).toBe(true);
    expect(isJumboEmoji("🇧🇷")).toBe(true);
    expect(isJumboEmoji("👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽")).toBe(true);
  });

  it("refuses text, digits, more than six and nothing", () => {
    expect(isJumboEmoji("boa 🔥")).toBe(false);
    expect(isJumboEmoji("12")).toBe(false);
    expect(isJumboEmoji("🔥🔥🔥🔥🔥🔥🔥")).toBe(false);
    expect(isJumboEmoji("")).toBe(false);
    expect(isJumboEmoji("   ")).toBe(false);
    expect(isJumboEmoji(null)).toBe(false);
    expect(isJumboEmoji(":custom:")).toBe(false);
  });
});

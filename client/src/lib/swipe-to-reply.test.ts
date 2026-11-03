import { describe, expect, it } from "vitest";
import { SWIPE_REPLY_AT, SWIPE_REPLY_MAX, swipeOffset } from "./swipe-to-reply";

describe("swipeOffset", () => {
  it("never moves left", () => {
    expect(swipeOffset(-40)).toBe(0);
  });

  it("follows the finger up to the reply point", () => {
    expect(swipeOffset(30)).toBe(30);
    expect(swipeOffset(SWIPE_REPLY_AT)).toBe(SWIPE_REPLY_AT);
  });

  it("drags past the point and stops at the cap", () => {
    const past = swipeOffset(SWIPE_REPLY_AT + 20);
    expect(past).toBeGreaterThan(SWIPE_REPLY_AT);
    expect(past).toBeLessThan(SWIPE_REPLY_AT + 20);
    expect(swipeOffset(400)).toBe(SWIPE_REPLY_MAX);
  });
});

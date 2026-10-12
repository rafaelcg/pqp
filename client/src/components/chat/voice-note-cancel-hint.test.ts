import { describe, expect, it } from "vitest";
import { cancelHintOffset } from "./voice-note-composer";

describe("cancelHintOffset", () => {
  it("does not move before the finger slides", () => {
    expect(cancelHintOffset(0)).toBe(0);
    expect(cancelHintOffset(4)).toBe(0);
  });

  it("follows the finger at half speed at first", () => {
    expect(cancelHintOffset(-10)).toBe(-5);
  });

  it("stops short of the timer however far the finger goes", () => {
    // The hint sits 18px right of the timer (row gap 10 + margin 8). Whatever
    // the slide, the offset must leave the timer clear.
    for (const x of [-24, -48, -96, -400]) {
      expect(cancelHintOffset(x)).toBeGreaterThan(-18);
    }
    expect(cancelHintOffset(-96)).toBe(cancelHintOffset(-400));
  });
});

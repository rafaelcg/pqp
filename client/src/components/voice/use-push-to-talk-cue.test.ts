import { describe, expect, it } from "vitest";
import { pttHeldCue } from "@/lib/sounds";

describe("push-to-talk held transitions", () => {
  it("beeps on press, stays quiet on key repeat, and beeps off on release", () => {
    let held = false;
    const cues: Array<ReturnType<typeof pttHeldCue>> = [];
    for (const next of [true, true, true, false]) {
      cues.push(pttHeldCue(held, next));
      held = next;
    }
    expect(cues).toEqual(["on", null, null, "off"]);
  });
});

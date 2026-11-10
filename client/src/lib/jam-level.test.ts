import { describe, expect, it } from "vitest";
import { levelBar, levelVerdict } from "./jam-level";

describe("the level meter's advice", () => {
  it("says silent when almost nothing comes in", () => {
    expect(levelVerdict(0)).toBe("silent");
    expect(levelVerdict(0.005)).toBe("silent");
    expect(levelVerdict(Number.NaN)).toBe("silent");
  });

  it("says low for a quiet signal and good for a healthy one", () => {
    expect(levelVerdict(0.04)).toBe("low");
    expect(levelVerdict(0.3)).toBe("good");
    expect(levelVerdict(0.9)).toBe("good");
  });

  it("says hot just under full scale", () => {
    expect(levelVerdict(0.98)).toBe("hot");
    expect(levelVerdict(1)).toBe("hot");
  });

  it("draws quiet playing wider than a linear bar would", () => {
    expect(levelBar(0.04)).toBeCloseTo(0.2);
    expect(levelBar(0)).toBe(0);
    expect(levelBar(4)).toBe(1);
  });
});

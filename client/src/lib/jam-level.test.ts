import { describe, expect, it } from "vitest";
import { SILENCE_WARN_MS, judgeLevel, levelBar, levelVerdict } from "./jam-level";

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

describe("the meter only warns about sustained silence", () => {
  it("says nothing for the first seconds of quiet, between two notes", () => {
    let clock = { silentSince: null as number | null };
    for (const at of [0, 500, 1500, SILENCE_WARN_MS - 1]) {
      const step = judgeLevel(clock, 0.001, at);
      clock = step.clock;
      expect(step.verdict).toBeNull();
    }
  });

  it("warns once the quiet has lasted long enough", () => {
    let clock = { silentSince: null as number | null };
    clock = judgeLevel(clock, 0, 0).clock;
    expect(judgeLevel(clock, 0, SILENCE_WARN_MS).verdict).toBe("silent");
  });

  it("starts the count again after a note", () => {
    let clock = { silentSince: null as number | null };
    clock = judgeLevel(clock, 0, 0).clock;
    clock = judgeLevel(clock, 0.4, 2900).clock;
    expect(judgeLevel(clock, 0, 3500).verdict).toBeNull();
    expect(judgeLevel(clock, 0.4, 3600).verdict).toBe("good");
  });

  it("speaks about a low or hot signal at once", () => {
    expect(judgeLevel({ silentSince: null }, 0.04, 0).verdict).toBe("low");
    expect(judgeLevel({ silentSince: null }, 0.99, 0).verdict).toBe("hot");
  });
});

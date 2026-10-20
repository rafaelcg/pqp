import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import { INSERT_MS, loadSteps, REDUCED_MS, REVEAL_MS, revealMs, stepStates } from "./load-flow";

describe("loadSteps", () => {
  it("splits the one line of copy into the three steps, in every language", () => {
    for (const locale of ["pt-BR", "en", "es"] as const) {
      const steps = loadSteps(STRINGS[locale]["load.steps"]);
      expect(steps.every((step) => step.length > 0), locale).toBe(true);
    }
    expect(loadSteps("Lendo a fita · Ligando o console · Pronto")).toEqual(["Lendo a fita", "Ligando o console", "Pronto"]);
  });

  it("never throws on a line with no dots: the whole line is step one", () => {
    expect(loadSteps("so um")).toEqual(["so um", "", ""]);
  });
});

describe("stepStates", () => {
  it("marks what is behind as done, the current as active and the rest as todo", () => {
    expect(stepStates(1)).toEqual(["active", "todo", "todo"]);
    expect(stepStates(2)).toEqual(["done", "active", "todo"]);
    expect(stepStates(3)).toEqual(["done", "done", "active"]);
  });
});

describe("the motion's timings (SPEC 7)", () => {
  it("is 300 ms to insert and to reveal, and a 150 ms crossfade with reduced motion", () => {
    expect(INSERT_MS).toBe(300);
    expect(REVEAL_MS).toBe(300);
    expect(REDUCED_MS).toBe(150);
    expect(revealMs(false)).toBe(300);
    expect(revealMs(true)).toBe(150);
  });
});

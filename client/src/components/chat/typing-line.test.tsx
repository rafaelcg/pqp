import { describe, expect, it } from "vitest";
import { typingLabel } from "./typing-line";

const t = ((key: string, vars?: Record<string, unknown>) => `${key}:${JSON.stringify(vars ?? {})}`) as never;

describe("typingLabel", () => {
  it("is empty for nobody", () => {
    expect(typingLabel(t, [])).toBe("");
  });

  it("names one or two people and counts the rest", () => {
    expect(typingLabel(t, ["Bia"])).toContain("chat.typing_one");
    expect(typingLabel(t, ["Bia", "Rafa"])).toContain("chat.typing_two");
    expect(typingLabel(t, ["Bia", "Rafa", "Caio"])).toContain('"count":3');
    expect(typingLabel(t, Array.from({ length: 21 }, (_, i) => `p${i}`))).toContain("chat.typingMany");
  });
});

import { describe, expect, it } from "vitest";
import { winningCornerHint } from "./corner-hints";

describe("winningCornerHint", () => {
  it("returns null when nobody wants the corner", () => {
    expect(winningCornerHint({})).toBeNull();
    expect(winningCornerHint({ qg: false, cargos: false })).toBeNull();
  });

  it("lets the QG go first, then dice, then cargos", () => {
    expect(
      winningCornerHint({ qg: true, whatsNew: true, cargos: true }),
    ).toBe("qg");
    expect(winningCornerHint({ whatsNew: true, cargos: true })).toBe(
      "whatsNew",
    );
    expect(winningCornerHint({ cargos: true })).toBe("cargos");
  });
});

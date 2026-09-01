import { describe, expect, it } from "vitest";
import { winningCornerHint } from "./corner-hints";

describe("winningCornerHint", () => {
  it("returns null when nobody wants the corner", () => {
    expect(winningCornerHint({})).toBeNull();
    expect(winningCornerHint({ qg: false, cargos: false })).toBeNull();
  });

  it("lets the QG go first, then the phone beta, then dice, then cargos", () => {
    expect(
      winningCornerHint({
        qg: true,
        mobileBeta: true,
        whatsNew: true,
        cargos: true,
      }),
    ).toBe("qg");
    expect(
      winningCornerHint({
        mobileBeta: true,
        whatsNew: true,
        cargos: true,
      }),
    ).toBe("mobileBeta");
    expect(winningCornerHint({ whatsNew: true, cargos: true })).toBe(
      "whatsNew",
    );
    expect(winningCornerHint({ cargos: true })).toBe("cargos");
  });

  it("a waiting build beats every campaign", () => {
    expect(winningCornerHint({ update: true, qg: true, whatsNew: true })).toBe(
      "update",
    );
  });
});

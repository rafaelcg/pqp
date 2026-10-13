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
    expect(winningCornerHint({ shortcuts: true })).toBe("shortcuts");
    expect(winningCornerHint({ cargos: true, shortcuts: true })).toBe(
      "cargos",
    );
  });

  it("puts the notification offer after a Baú post, before the QG", () => {
    expect(winningCornerHint({ notifyOffer: true, qg: true, cargos: true })).toBe(
      "notifyOffer",
    );
    expect(
      winningCornerHint({ communityHomePost: true, notifyOffer: true }),
    ).toBe("communityHomePost");
  });

  it("puts the Voz limpa nudge after QG and before the phone beta", () => {
    expect(
      winningCornerHint({
        qg: true,
        voiceClean: true,
        mobileBeta: true,
      }),
    ).toBe("qg");
    expect(
      winningCornerHint({
        voiceClean: true,
        mobileBeta: true,
        whatsNew: true,
      }),
    ).toBe("voiceClean");
  });

  it("a live Baú post beats first-run cards", () => {
    expect(
      winningCornerHint({
        communityHomePost: true,
        qg: true,
        cargos: true,
      }),
    ).toBe("communityHomePost");
  });
});

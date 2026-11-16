import { JAM_INSTRUMENTS } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { asInstrument, INSTRUMENT_LOOK, INSTRUMENTS, isInstrument } from "./instruments";
import { tabKeeps } from "./use-jam-data";

describe("instruments", () => {
  it("are exactly the contract's, each with a look", () => {
    expect([...INSTRUMENTS].sort()).toEqual([...JAM_INSTRUMENTS].sort());
    for (const instrument of JAM_INSTRUMENTS) {
      expect(INSTRUMENT_LOOK[instrument].token).toBe(`--color-inst-${instrument}`);
    }
  });

  it("reads an instrument a newer server may send as other", () => {
    expect(asInstrument("theremin")).toBe("other");
    expect(asInstrument("bass")).toBe("bass");
    expect(isInstrument("theremin")).toBe(false);
  });
});

describe("the tabs that filter a page", () => {
  it("keep a song by what it still needs", () => {
    expect(tabKeeps("needs", { needs: ["bass"] })).toBe(true);
    expect(tabKeeps("needs", { needs: [] })).toBe(false);
    expect(tabKeeps("done", { needs: [] })).toBe(true);
    expect(tabKeeps("done", { needs: ["bass"] })).toBe(false);
    expect(tabKeeps("top", { needs: ["bass"] })).toBe(true);
    expect(tabKeeps("new", { needs: [] })).toBe(true);
  });
});

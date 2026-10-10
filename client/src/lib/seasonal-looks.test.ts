import { describe, expect, it } from "vitest";
import {
  SEASON_OVERRIDE_KEY,
  currentSeason,
  isLookOffered,
  seasonalHintKey,
} from "./seasonal-looks";

const empty = { getItem: () => null };
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);

describe("currentSeason", () => {
  it("is Halloween from 1 October through 2 November", () => {
    expect(currentSeason(day(2026, 9, 30), empty)).toBeNull();
    expect(currentSeason(day(2026, 10, 1), empty)).toBe("halloween");
    expect(currentSeason(day(2026, 10, 31), empty)).toBe("halloween");
    expect(currentSeason(day(2026, 11, 2), empty)).toBe("halloween");
    expect(currentSeason(day(2026, 11, 3), empty)).toBeNull();
  });

  it("is Christmas from 1 December through 6 January, across the new year", () => {
    expect(currentSeason(day(2026, 11, 30), empty)).toBeNull();
    expect(currentSeason(day(2026, 12, 1), empty)).toBe("christmas");
    expect(currentSeason(day(2026, 12, 31), empty)).toBe("christmas");
    expect(currentSeason(day(2027, 1, 6), empty)).toBe("christmas");
    expect(currentSeason(day(2027, 1, 7), empty)).toBeNull();
  });

  it("follows the QA override, and ignores a value it does not know", () => {
    const at = (value: string) => ({
      getItem: (key: string) => (key === SEASON_OVERRIDE_KEY ? value : null),
    });
    expect(currentSeason(day(2026, 6, 1), at("christmas"))).toBe("christmas");
    expect(currentSeason(day(2026, 10, 10), at("none"))).toBeNull();
    expect(currentSeason(day(2026, 10, 10), at("easter"))).toBe("halloween");
  });
});

describe("isLookOffered", () => {
  it("always offers the year-round looks", () => {
    expect(isLookOffered("night", "signal", null)).toBe(true);
  });

  it("offers a seasonal look in its season or while it is on", () => {
    expect(isLookOffered("halloween", "signal", "halloween")).toBe(true);
    expect(isLookOffered("christmas", "signal", "halloween")).toBe(false);
    expect(isLookOffered("halloween", "halloween", null)).toBe(true);
    expect(isLookOffered("halloween", "signal", null)).toBe(false);
  });
});

describe("seasonalHintKey", () => {
  it("counts early January as the previous year's Christmas", () => {
    expect(seasonalHintKey("christmas", day(2026, 12, 20))).toBe(
      seasonalHintKey("christmas", day(2027, 1, 3)),
    );
    expect(seasonalHintKey("halloween", day(2026, 10, 10))).toBe(
      "pqp:seasonal-look-halloween-2026",
    );
  });
});

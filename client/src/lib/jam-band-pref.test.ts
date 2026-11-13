import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bandFits, bandHeight, readBandOpen, writeBandOpen } from "./jam-band-pref";

/** A storage of its own, so the test does not depend on what the runtime's global `localStorage` is. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the band's remembered choice", () => {
  it("is null until somebody chooses, then follows them, per account", () => {
    expect(readBandOpen("a")).toBeNull();
    writeBandOpen("a", true);
    writeBandOpen("b", false);
    expect(readBandOpen("a")).toBe(true);
    expect(readBandOpen("b")).toBe(false);
    expect(readBandOpen("c")).toBeNull();
    expect(readBandOpen(null)).toBeNull();
  });

  it("forgets quietly when storage throws", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(readBandOpen("a")).toBeNull();
    expect(() => writeBandOpen("a", true)).not.toThrow();
  });
});

describe("room for the lanes", () => {
  it("needs more height for a narrow band, where a lane is two lines", () => {
    expect(bandHeight(4, 500)).toBeGreaterThan(bandHeight(4, 900));
  });

  it("is open by default only when every lane fits", () => {
    expect(bandFits(bandHeight(4, 900), 4, 900)).toBe(true);
    expect(bandFits(bandHeight(4, 900) - 1, 4, 900)).toBe(false);
    expect(bandFits(10_000, 0, 900)).toBe(false);
  });
});

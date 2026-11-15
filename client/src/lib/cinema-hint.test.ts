import { describe, expect, it } from "vitest";
import {
  CINEMA_HINT_STORAGE_KEY,
  cinemaHintPersists,
  HINTS_PERSIST_OVERRIDE_KEY,
  isCinemaHintSeen,
  rememberCinemaHint,
  shouldShowCinemaHint,
} from "./cinema-hint";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

describe("shouldShowCinemaHint", () => {
  it("iOS in a browser tab, once", () => {
    expect(shouldShowCinemaHint({ ios: true, standalone: false, seen: false })).toBe(true);
  });

  it("not on the home screen, not on Android or desktop, not twice", () => {
    expect(shouldShowCinemaHint({ ios: true, standalone: true, seen: false })).toBe(false);
    expect(shouldShowCinemaHint({ ios: false, standalone: false, seen: false })).toBe(false);
    expect(shouldShowCinemaHint({ ios: true, standalone: false, seen: true })).toBe(false);
  });
});

describe("persistence", () => {
  it("follows the shared store: a real host persists, localhost does not", () => {
    expect(cinemaHintPersists(memoryStorage(), "pqp.gg")).toBe(true);
    expect(cinemaHintPersists(memoryStorage(), "localhost")).toBe(false);
  });

  it("the override key makes localhost persist, for the suite that proves once", () => {
    const storage = memoryStorage({ [HINTS_PERSIST_OVERRIDE_KEY]: "1" });
    expect(cinemaHintPersists(storage, "localhost")).toBe(true);
  });

  it("remember then seen, under the shared key", () => {
    const storage = memoryStorage();
    expect(isCinemaHintSeen(storage, true)).toBe(false);
    rememberCinemaHint(storage, true);
    expect(storage.map.get(CINEMA_HINT_STORAGE_KEY)).toBe("1");
    expect(isCinemaHintSeen(storage, true)).toBe(true);
  });

  it("without persistence nothing is written and nothing is seen", () => {
    const storage = memoryStorage();
    rememberCinemaHint(storage, false);
    expect(storage.map.size).toBe(0);
    expect(isCinemaHintSeen(storage, false)).toBe(false);
  });
});

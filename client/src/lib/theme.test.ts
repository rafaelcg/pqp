import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
}));

import { queuePreferenceSync } from "./preferences";
import { adoptAppearancePreference, getAppearance } from "./appearance";
import {
  THEME_STORAGE_KEY,
  adoptThemePreference,
  getThemeState,
  themeToAdopt,
} from "./theme";

describe("themeToAdopt", () => {
  it("pins Dark when the effective look is Night", () => {
    expect(themeToAdopt("light", "night")).toBe("dark");
    expect(themeToAdopt("system", "night")).toBe("dark");
    expect(themeToAdopt(undefined, "night")).toBe("dark");
  });

  it("keeps the server theme for every other look", () => {
    expect(themeToAdopt("light", "signal")).toBe("light");
    expect(themeToAdopt("system", "harmony")).toBe("system");
    expect(themeToAdopt(undefined, "hearth")).toBeUndefined();
  });
});

describe("adoptThemePreference", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.mocked(queuePreferenceSync).mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not write the account back", () => {
    adoptAppearancePreference("signal");
    adoptThemePreference("light");

    expect(getThemeState().preference).toBe("light");
    expect(store.get(THEME_STORAGE_KEY)).toBe("light");
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("keeps Dark when local Night meets a server Light and no appearance", () => {
    adoptAppearancePreference("night");
    const next = themeToAdopt("light", getAppearance());
    expect(next).toBe("dark");
    if (next) {
      adoptThemePreference(next);
    }

    expect(getThemeState().preference).toBe("dark");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("coerces a direct Light adopt while Night is the effective look", () => {
    adoptAppearancePreference("night");
    adoptThemePreference("light");

    expect(getThemeState().preference).toBe("dark");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
  });
});

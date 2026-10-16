// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
  isPreferencePending: vi.fn(() => false),
  preferenceWrittenSince: vi.fn(() => false),
}));

import {
  adoptAppearancePreference,
  getAppearance,
  getLook,
  reloadRetroLookForTests,
  setRetroLook,
} from "./appearance";
import { adoptLook, chooseLook, MODE_BEFORE_NIGHT_KEY } from "./choose-look";
import { adoptThemePreference, getThemeState, setThemePreference } from "./theme";

describe("chooseLook and adoptLook", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadRetroLookForTests();
    adoptAppearancePreference("signal");
    adoptThemePreference("light");
  });

  afterEach(() => {
    setRetroLook(false);
    localStorage.clear();
  });

  it("gives a Light user Light back after a seasonal look", () => {
    chooseLook("halloween");
    expect(getThemeState().preference).toBe("dark");

    chooseLook("signal");
    expect(getAppearance()).toBe("signal");
    expect(getThemeState().preference).toBe("light");
  });

  it("keeps the note across two dark-only looks", () => {
    chooseLook("night");
    chooseLook("christmas");
    chooseLook("hearth");
    expect(getThemeState().preference).toBe("light");
  });

  it("notes the mode when another device's dark-only look is adopted", () => {
    adoptLook("halloween");
    expect(getThemeState().preference).toBe("dark");
    expect(localStorage.getItem(MODE_BEFORE_NIGHT_KEY)).toBe("light");

    chooseLook("signal");
    expect(getThemeState().preference).toBe("light");
  });

  it("does not overwrite the note when adoption moves between dark-only looks", () => {
    chooseLook("night");
    adoptLook("christmas");
    expect(localStorage.getItem(MODE_BEFORE_NIGHT_KEY)).toBe("light");
  });

  it("leaves Modo 2005 for the look under it without moving the mode", () => {
    setThemePreference("system");
    setRetroLook(true);
    expect(getLook()).toBe("retro");

    chooseLook("signal");
    expect(getLook()).toBe("signal");
    expect(getThemeState().preference).toBe("system");
  });
});

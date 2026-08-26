import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
}));

import { queuePreferenceSync } from "./preferences";
import {
  APPEARANCE_STORAGE_KEY,
  adoptAppearancePreference,
  appearanceForcesDark,
  getAppearance,
  isAppearance,
  readStoredAppearance,
  setAppearancePreference,
} from "./appearance";

describe("isAppearance", () => {
  it("accepts the four skins the stylesheet defines", () => {
    expect(isAppearance("signal")).toBe(true);
    expect(isAppearance("harmony")).toBe(true);
    expect(isAppearance("hearth")).toBe(true);
    expect(isAppearance("night")).toBe(true);
  });

  it("rejects a brand name and anything else", () => {
    expect(isAppearance("discord")).toBe(false);
    expect(isAppearance("onyx")).toBe(false);
    expect(isAppearance("slack")).toBe(false);
    expect(isAppearance("neon")).toBe(false);
    expect(isAppearance(null)).toBe(false);
  });

  it("pins Night to dark and leaves the other looks free", () => {
    expect(appearanceForcesDark("night")).toBe(true);
    expect(appearanceForcesDark("signal")).toBe(false);
    expect(appearanceForcesDark("harmony")).toBe(false);
    expect(appearanceForcesDark("hearth")).toBe(false);
  });
});

describe("stored appearance", () => {
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

  it("treats a missing or invalid value as no choice yet", () => {
    expect(readStoredAppearance()).toBeNull();
    store.set(APPEARANCE_STORAGE_KEY, "discord");
    expect(readStoredAppearance()).toBeNull();
    store.set(APPEARANCE_STORAGE_KEY, "guild");
    expect(readStoredAppearance()).toBe("harmony");
    store.set(APPEARANCE_STORAGE_KEY, "accord");
    expect(readStoredAppearance()).toBe("harmony");
  });

  it("adopts a server value without writing it back", () => {
    adoptAppearancePreference("harmony");

    expect(getAppearance()).toBe("harmony");
    expect(readStoredAppearance()).toBe("harmony");
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("a user choice syncs immediately", () => {
    setAppearancePreference("hearth");

    expect(getAppearance()).toBe("hearth");
    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { appearance: "hearth" },
      { immediate: true },
    );
  });

  it("picking Night pins dark on the same write", () => {
    setAppearancePreference("night");

    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { appearance: "night", theme: "dark" },
      { immediate: true },
    );
    expect(queuePreferenceSync).toHaveBeenCalledTimes(1);
  });
});

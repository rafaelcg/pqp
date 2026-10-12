import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queuePreferenceSync } from "./preferences";
import {
  APPEARANCE_STORAGE_KEY,
  RETRO_KILLED_STORAGE_KEY,
  RETRO_STORAGE_KEY,
  adoptAppearancePreference,
  appearanceForcesDark,
  getAppearance,
  getLook,
  isAppearance,
  isRetroLookOn,
  readStoredAppearance,
  reloadRetroLookForTests,
  setAppearancePreference,
  setRetroLook,
  setRetroLookAvailable,
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

describe("Modo 2005 over the preference", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.mocked(queuePreferenceSync).mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    reloadRetroLookForTests();
    adoptAppearancePreference("harmony");
  });

  afterEach(() => {
    setRetroLook(false);
    setRetroLookAvailable(true);
    vi.unstubAllGlobals();
  });

  it("paints retro, keeps the look underneath, and never syncs", () => {
    setRetroLook(true);

    expect(getLook()).toBe("retro");
    expect(getAppearance()).toBe("harmony");
    expect(store.get(RETRO_STORAGE_KEY)).toBe("1");
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("a value from the server keeps it on", () => {
    setRetroLook(true);
    adoptAppearancePreference("hearth");

    expect(getLook()).toBe("retro");
    expect(getAppearance()).toBe("hearth");
  });

  it("picking any look turns it off", () => {
    setRetroLook(true);
    setAppearancePreference("harmony");

    expect(isRetroLookOn()).toBe(false);
    expect(getLook()).toBe("harmony");
    expect(store.has(RETRO_STORAGE_KEY)).toBe(false);
  });

  it("the kill switch paints the look underneath and keeps the choice", () => {
    setRetroLook(true);
    setRetroLookAvailable(false);

    expect(getLook()).toBe("harmony");
    expect(store.get(RETRO_KILLED_STORAGE_KEY)).toBe("1");
    expect(store.get(RETRO_STORAGE_KEY)).toBe("1");

    setRetroLookAvailable(true);
    expect(getLook()).toBe("retro");
  });

  it("the boot script reads the same two keys", () => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../index.html"),
      "utf8",
    );
    expect(html).toContain(`localStorage.getItem("${RETRO_STORAGE_KEY}") === "1"`);
    expect(html).toContain(
      `localStorage.getItem("${RETRO_KILLED_STORAGE_KEY}") !== "1"`,
    );
    expect(html).toContain('dataset.appearance = "retro"');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
}));

import { queuePreferenceSync } from "./preferences";
import {
  ACCENT_HUE_STORAGE_KEY,
  adoptAccentHuePreference,
  effectiveAccentHue,
  getAccentHue,
  parseStoredAccentHue,
  readStoredAccentHue,
  setAccentHuePreference,
} from "./accent";

describe("parseStoredAccentHue", () => {
  it("accepts default and an integer hue", () => {
    expect(parseStoredAccentHue("default")).toBe("default");
    expect(parseStoredAccentHue("210")).toBe(210);
    expect(parseStoredAccentHue("361")).toBeNull();
    expect(parseStoredAccentHue("blue")).toBeNull();
    expect(parseStoredAccentHue(null)).toBeNull();
  });
});

describe("effectiveAccentHue", () => {
  it("uses the look's own hue until the user picks one", () => {
    expect(effectiveAccentHue("default", "harmony")).toBe(255);
    expect(effectiveAccentHue("default", "night")).toBe(125);
    expect(effectiveAccentHue(40, "harmony")).toBe(40);
  });
});

describe("stored accent hue", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.mocked(queuePreferenceSync).mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {},
        style: { setProperty: () => {}, removeProperty: () => {} },
      },
      createElement: () => ({ style: {}, remove: () => {} }),
      body: { appendChild: () => {} },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adopts a server value without writing it back", () => {
    adoptAccentHuePreference(210);

    expect(getAccentHue()).toBe(210);
    expect(readStoredAccentHue()).toBe(210);
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("a custom hue syncs on the debounce path", () => {
    setAccentHuePreference(40);

    expect(getAccentHue()).toBe(40);
    expect(store.get(ACCENT_HUE_STORAGE_KEY)).toBe("40");
    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { accentHue: 40 },
      { immediate: false },
    );
  });

  it("resetting to the look syncs immediately", () => {
    setAccentHuePreference("default");

    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { accentHue: "default" },
      { immediate: true },
    );
  });
});

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
  hydrateAccentHue,
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

  it("a swatch click can sync immediately", () => {
    setAccentHuePreference(210, { immediate: true });

    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { accentHue: 210 },
      { immediate: true },
    );
  });

  it("resetting to the look syncs immediately", () => {
    setAccentHuePreference("default");

    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { accentHue: "default" },
      { immediate: true },
    );
  });

  it("probes the picker rgb when the boot script already set a custom hue", () => {
    const setProperty = vi.fn();
    const dataset: Record<string, string | undefined> = { accent: "custom" };
    vi.stubGlobal("document", {
      documentElement: {
        dataset,
        style: { setProperty, removeProperty: () => {} },
      },
      createElement: () => ({ style: {}, remove: () => {} }),
      body: { appendChild: () => {} },
    });
    vi.stubGlobal("getComputedStyle", () => ({ color: "rgb(10, 20, 30)" }));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });

    adoptAccentHuePreference(210);
    setProperty.mockClear();
    hydrateAccentHue();

    expect(setProperty).toHaveBeenCalledWith("--rgb-picker-accent", "10, 20, 30");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
}));

import { queuePreferenceSync } from "./preferences";
import {
  CONTRAST_STORAGE_KEY,
  adoptContrastPreference,
  applyContrast,
  getContrastState,
  readStoredContrast,
  resolveContrast,
  setContrastPreference,
} from "./contrast";

describe("stored contrast", () => {
  const store = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};

  beforeEach(() => {
    store.clear();
    for (const key of Object.keys(dataset)) {
      delete dataset[key];
    }
    vi.mocked(queuePreferenceSync).mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    vi.stubGlobal("document", {
      documentElement: { dataset },
    });
    vi.stubGlobal("window", {
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a missing or invalid value as no choice yet", () => {
    expect(readStoredContrast()).toBeNull();
    store.set(CONTRAST_STORAGE_KEY, "loud");
    expect(readStoredContrast()).toBeNull();
  });

  it("adopts a server value without writing it back", () => {
    adoptContrastPreference("more");

    expect(getContrastState().preference).toBe("more");
    expect(getContrastState().resolved).toBe("more");
    expect(readStoredContrast()).toBe("more");
    expect(dataset.contrast).toBe("more");
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("a user choice syncs immediately", () => {
    setContrastPreference("more");

    expect(getContrastState().preference).toBe("more");
    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { contrast: "more" },
      { immediate: true },
    );
  });

  it("clears the attribute when contrast returns to default", () => {
    applyContrast("more");
    expect(dataset.contrast).toBe("more");
    applyContrast("default");
    expect(dataset.contrast).toBeUndefined();
  });

  it("system follows prefers-contrast: more", () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    expect(resolveContrast("system")).toBe("more");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
  isPreferencePending: vi.fn(() => false),
  preferenceWrittenSince: vi.fn(() => false),
}));

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPreferencePending,
  preferenceWrittenSince,
  queuePreferenceSync,
} from "./preferences";
import {
  APPEARANCES,
  APPEARANCE_STORAGE_KEY,
  RETRO_KILLED_STORAGE_KEY,
  RETRO_SYNCED_STORAGE_KEY,
  mergeAccountAppearance,
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
  it("accepts every look the stylesheet defines", () => {
    for (const look of [
      "signal",
      "harmony",
      "hearth",
      "night",
      "ocean",
      "catppuccin",
      "everforest",
    ]) {
      expect(isAppearance(look)).toBe(true);
    }
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
    expect(appearanceForcesDark("ocean")).toBe(false);
  });
});

describe("the boot script in index.html", () => {
  // The pre-paint script cannot import this module, so its list is a copy.
  it("accepts exactly the looks APPEARANCES lists", () => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../index.html"),
      "utf8",
    );
    const script = html.slice(html.indexOf('getItem("pqp-appearance")'));
    const list = /\[([^\]]*)\]\.includes\(storedAppearance\)/.exec(script)?.[1];
    expect(list).toBeDefined();
    const boot = [...list!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(["signal", ...boot].sort()).toEqual([...APPEARANCES].sort());
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

  it("paints retro, keeps the look underneath, and tells the account", () => {
    setRetroLook(true);

    expect(getLook()).toBe("retro");
    expect(getAppearance()).toBe("harmony");
    expect(store.get(RETRO_STORAGE_KEY)).toBe("1");
    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { appearance: "retro" },
      { immediate: true },
    );
  });

  it("turning it off sends the look underneath back", () => {
    setRetroLook(true);
    vi.mocked(queuePreferenceSync).mockClear();
    setRetroLook(false);

    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { appearance: "harmony" },
      { immediate: true },
    );
  });

  it("the account saying retro turns it on here, without writing back", () => {
    adoptAppearancePreference("retro");

    expect(getLook()).toBe("retro");
    expect(getAppearance()).toBe("harmony");
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("the account naming another look turns it off here (another device left it)", () => {
    setRetroLook(true);
    vi.mocked(queuePreferenceSync).mockClear();
    adoptAppearancePreference("hearth");

    expect(getLook()).toBe("hearth");
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("a look turned on here before it synced is sent up once, not undone", () => {
    store.clear();
    store.set(RETRO_STORAGE_KEY, "1");
    reloadRetroLookForTests();
    vi.mocked(queuePreferenceSync).mockClear();

    adoptAppearancePreference("signal");

    expect(getLook()).toBe("retro");
    expect(getAppearance()).toBe("signal");
    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { appearance: "retro" },
      { immediate: true },
    );
    expect(store.get(RETRO_SYNCED_STORAGE_KEY)).toBe("1");

    // From then on the account wins.
    vi.mocked(queuePreferenceSync).mockClear();
    adoptAppearancePreference("hearth");
    expect(getLook()).toBe("hearth");
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });

  it("a read that arrives while this tab's write is unanswered does not undo it", () => {
    setRetroLook(true);
    vi.mocked(isPreferencePending).mockReturnValueOnce(true);

    adoptAppearancePreference("signal");

    expect(getLook()).toBe("retro");
  });

  it("a read that began before this tab's write, answered after it landed, does not undo it", () => {
    setRetroLook(true);
    vi.mocked(preferenceWrittenSince).mockImplementationOnce(
      (key, generation) => key === "appearance" && generation === 7,
    );

    adoptAppearancePreference("signal", 7);

    expect(getLook()).toBe("retro");
  });

  it("an account with no look at all still receives an unsynced Modo 2005", () => {
    store.clear();
    store.set(RETRO_STORAGE_KEY, "1");
    reloadRetroLookForTests();
    vi.mocked(queuePreferenceSync).mockClear();

    adoptAppearancePreference(undefined);

    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { appearance: "retro" },
      { immediate: true },
    );
  });

  it("a stored `retro` from an older tab reads as Modo 2005 over the default", () => {
    store.clear();
    store.set(APPEARANCE_STORAGE_KEY, "retro");
    reloadRetroLookForTests();

    expect(isRetroLookOn()).toBe(true);
    adoptAppearancePreference("retro");
    expect(getAppearance()).toBe("signal");
    expect(store.get(APPEARANCE_STORAGE_KEY)).toBe("signal");
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
    expect(html).toContain('storedAppearance === "retro"');
  });
});

describe("mergeAccountAppearance", () => {
  it("the account is the truth once the look has synced", () => {
    expect(
      mergeAccountAppearance({ account: "retro", localRetro: false, synced: true }),
    ).toEqual({ retro: true, base: null, push: false });
    expect(
      mergeAccountAppearance({ account: "night", localRetro: true, synced: true }),
    ).toEqual({ retro: false, base: "night", push: false });
  });

  it("a local-only Modo 2005 survives its first meeting with the account", () => {
    expect(
      mergeAccountAppearance({ account: "signal", localRetro: true, synced: false }),
    ).toEqual({ retro: true, base: "signal", push: true });
    expect(
      mergeAccountAppearance({ account: "signal", localRetro: false, synced: false }),
    ).toEqual({ retro: false, base: "signal", push: false });
  });
});

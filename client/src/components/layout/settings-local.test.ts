import { afterEach, describe, expect, it, vi } from "vitest";
import { SPEAKING_THRESHOLD } from "@/lib/voice-audio";

const store = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
});

const { defaultLocalSettings, loadLocalSettings } = await import(
  "./settings-modal"
);

describe("loadLocalSettings vadThreshold", () => {
  afterEach(() => {
    store.clear();
  });

  it("defaults to the speaking threshold and keeps a stored value", () => {
    expect(defaultLocalSettings.vadThreshold).toBe(SPEAKING_THRESHOLD);
    expect(loadLocalSettings().vadThreshold).toBe(SPEAKING_THRESHOLD);

    store.set(
      "pqp-local-settings",
      JSON.stringify({ vadThreshold: 0.22 }),
    );
    expect(loadLocalSettings().vadThreshold).toBe(0.22);
  });

  it("clamps a hand-edited value and ignores garbage", () => {
    store.set("pqp-local-settings", JSON.stringify({ vadThreshold: 8 }));
    expect(loadLocalSettings().vadThreshold).toBe(1);

    store.set("pqp-local-settings", JSON.stringify({ vadThreshold: "loud" }));
    expect(loadLocalSettings().vadThreshold).toBe(SPEAKING_THRESHOLD);
  });
});

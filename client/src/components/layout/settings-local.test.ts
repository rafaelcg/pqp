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

const {
  defaultLocalSettings,
  displayMicLevel,
  loadLocalSettings,
  sliderToVadThreshold,
} = await import("./settings-modal");

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

describe("loadLocalSettings screenFrameRate", () => {
  afterEach(() => {
    store.clear();
  });

  it("defaults to auto and keeps a stored 30 or 60", async () => {
    const { parseScreenFrameRate } = await import("@/lib/hls-capture-rate");
    expect(parseScreenFrameRate(loadLocalSettings().screenFrameRate)).toBe(
      "auto",
    );
    expect(defaultLocalSettings.screenFrameRate).toBe("auto");

    store.set(
      "pqp-local-settings",
      JSON.stringify({ screenFrameRate: "60" }),
    );
    expect(loadLocalSettings().screenFrameRate).toBe("60");

    store.set(
      "pqp-local-settings",
      JSON.stringify({ screenFrameRate: "30" }),
    );
    expect(loadLocalSettings().screenFrameRate).toBe("30");
  });

  it("falls back to auto for junk", () => {
    store.set(
      "pqp-local-settings",
      JSON.stringify({ screenFrameRate: "120" }),
    );
    expect(loadLocalSettings().screenFrameRate).toBe("auto");
  });
});

describe("mic meter slider scale", () => {
  it("round-trips a slider percent onto the same displayed line", () => {
    const volume = 1;
    for (const percent of [0, 8, 40, 100]) {
      const stored = sliderToVadThreshold(percent, volume);
      expect(Math.round(displayMicLevel(stored, volume) * 100)).toBe(percent);
    }
  });
});

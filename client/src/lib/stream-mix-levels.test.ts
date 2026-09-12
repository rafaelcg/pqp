import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISPLAY_GAIN,
  DEFAULT_MIC_GAIN,
  DISPLAY_GAIN_RANGE,
  MIC_GAIN_RANGE,
  readStreamMixLevels,
  writeStreamMixLevels,
} from "./stream-mix-levels";

/** A Map-backed localStorage; the suite runs in `node` with no DOM. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } satisfies Storage;
}

describe("stream mix levels", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults to +6 dB mic, -3 dB display", () => {
    expect(DEFAULT_MIC_GAIN).toBe(2.0);
    expect(DEFAULT_DISPLAY_GAIN).toBe(0.7);
    expect(readStreamMixLevels()).toEqual({
      micGain: DEFAULT_MIC_GAIN,
      displayGain: DEFAULT_DISPLAY_GAIN,
    });
  });

  it("persists a choice and reads it back", () => {
    writeStreamMixLevels({ micGain: 2.8, displayGain: 0.5 });
    expect(readStreamMixLevels()).toEqual({ micGain: 2.8, displayGain: 0.5 });
  });

  it("clamps mic gain to 0.5 - 4", () => {
    writeStreamMixLevels({ micGain: 100 });
    expect(readStreamMixLevels().micGain).toBe(MIC_GAIN_RANGE.max);
    writeStreamMixLevels({ micGain: -5 });
    expect(readStreamMixLevels().micGain).toBe(MIC_GAIN_RANGE.min);
  });

  it("clamps display gain to 0.25 - 1", () => {
    writeStreamMixLevels({ displayGain: 5 });
    expect(readStreamMixLevels().displayGain).toBe(DISPLAY_GAIN_RANGE.max);
    writeStreamMixLevels({ displayGain: 0 });
    expect(readStreamMixLevels().displayGain).toBe(DISPLAY_GAIN_RANGE.min);
  });

  it("falls back to the default on junk", () => {
    window.localStorage.setItem("pqp:stream-mix-mic-gain", "not-a-number");
    window.localStorage.setItem("pqp:stream-mix-display-gain", "");
    expect(readStreamMixLevels()).toEqual({
      micGain: DEFAULT_MIC_GAIN,
      displayGain: DEFAULT_DISPLAY_GAIN,
    });
  });

  it("reads the safe defaults when storage is unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(readStreamMixLevels()).toEqual({
      micGain: DEFAULT_MIC_GAIN,
      displayGain: DEFAULT_DISPLAY_GAIN,
    });
  });

  it("writing one level leaves the other untouched", () => {
    writeStreamMixLevels({ micGain: 1.4 });
    expect(readStreamMixLevels()).toEqual({
      micGain: 1.4,
      displayGain: DEFAULT_DISPLAY_GAIN,
    });
  });
});

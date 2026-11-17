import { describe, expect, it } from "vitest";
import { forgetCheckSkipped, isCheckSkipped, rememberCheckSkipped } from "./jam-latency-skip";

function memory() {
  const held = new Map<string, string>();
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
}

describe("a skipped latency check is remembered per pair of devices", () => {
  it("is not skipped until somebody skips it", () => {
    expect(isCheckSkipped("mic|speakers|48000", memory())).toBe(false);
  });

  it("stays skipped for that pair and not for another", () => {
    const store = memory();
    rememberCheckSkipped("mic-a|headset|48000", store);
    expect(isCheckSkipped("mic-a|headset|48000", store)).toBe(true);
    expect(isCheckSkipped("mic-a|speakers|48000", store)).toBe(false);
  });

  it("is forgotten when the person asks to calibrate", () => {
    const store = memory();
    rememberCheckSkipped("k", store);
    forgetCheckSkipped("k", store);
    expect(isCheckSkipped("k", store)).toBe(false);
  });

  it("survives storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(isCheckSkipped("k", hostile)).toBe(false);
    expect(() => rememberCheckSkipped("k", hostile)).not.toThrow();
    expect(() => forgetCheckSkipped("k", hostile)).not.toThrow();
  });
});

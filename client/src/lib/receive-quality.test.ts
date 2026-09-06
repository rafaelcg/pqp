import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultReceiveQuality,
  getReceiveQuality,
  loadReceiveQuality,
  parseReceiveQuality,
  resetReceiveQualityForTests,
  saveReceiveQuality,
  setReceiveQuality,
  subscribeReceiveQuality,
} from "./receive-quality";

const DESKTOP = {
  coarsePointer: false,
  smallViewport: false,
  mobileUserAgent: false,
};

describe("receive quality device default", () => {
  it("is auto on a desktop", () => {
    expect(defaultReceiveQuality(DESKTOP)).toBe("auto");
  });

  it("is 720p on anything with a finger for a pointer", () => {
    expect(defaultReceiveQuality({ ...DESKTOP, coarsePointer: true })).toBe(
      "720p",
    );
  });

  it("is 720p on a narrow viewport, whatever the pointer", () => {
    expect(defaultReceiveQuality({ ...DESKTOP, smallViewport: true })).toBe(
      "720p",
    );
  });

  it("is 720p when the user agent says phone", () => {
    expect(defaultReceiveQuality({ ...DESKTOP, mobileUserAgent: true })).toBe(
      "720p",
    );
  });
});

describe("receive quality storage", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    resetReceiveQualityForTests();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetReceiveQualityForTests();
  });

  it("falls back to the device default when nothing is stored", () => {
    expect(loadReceiveQuality(DESKTOP)).toBe("auto");
    expect(loadReceiveQuality({ ...DESKTOP, coarsePointer: true })).toBe(
      "720p",
    );
  });

  it("round-trips a choice, and the choice beats the device default", () => {
    saveReceiveQuality("1080p");
    // A phone that chose 1080p gets 1080p. Anyone can pick 1080p.
    expect(loadReceiveQuality({ ...DESKTOP, coarsePointer: true })).toBe(
      "1080p",
    );
  });

  it("reads junk as the device default rather than as a size", () => {
    store.set("pqp:receive-quality", "4k");
    expect(loadReceiveQuality(DESKTOP)).toBe("auto");
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadReceiveQuality(DESKTOP)).toBe("auto");
    expect(() => saveReceiveQuality("360p")).not.toThrow();
  });

  it("tells subscribers about a change once, and remembers it", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeReceiveQuality((quality) => {
      seen.push(quality);
    });

    setReceiveQuality("360p");
    setReceiveQuality("360p");
    expect(seen).toEqual(["360p"]);
    expect(getReceiveQuality()).toBe("360p");
    expect(store.get("pqp:receive-quality")).toBe("360p");

    unsubscribe();
    setReceiveQuality("720p");
    expect(seen).toEqual(["360p"]);
  });
});

describe("parseReceiveQuality", () => {
  it("accepts the four rungs and nothing else", () => {
    expect(parseReceiveQuality("auto")).toBe("auto");
    expect(parseReceiveQuality("360p")).toBe("360p");
    // 480p is a send rung, not a receive rung: the presenter encodes no such
    // layer, so offering it would be a size the server cannot deliver.
    expect(parseReceiveQuality("480p")).toBeNull();
    expect(parseReceiveQuality(null)).toBeNull();
  });
});

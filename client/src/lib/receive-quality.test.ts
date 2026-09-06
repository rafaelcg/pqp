import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultReceiveQuality,
  getReceiveQuality,
  getReceiveQualityReason,
  isCellularConnection,
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

describe("the cellular default", () => {
  it("reads the Network Information API's three ways of saying metered", () => {
    expect(isCellularConnection(null)).toBe(false);
    expect(isCellularConnection({ type: "wifi", effectiveType: "4g" })).toBe(
      false,
    );
    expect(isCellularConnection({ type: "cellular", effectiveType: "4g" })).toBe(
      true,
    );
    expect(isCellularConnection({ effectiveType: "3g" })).toBe(true);
    expect(isCellularConnection({ effectiveType: "slow-2g" })).toBe(true);
    expect(isCellularConnection({ type: "wifi", saveData: true })).toBe(true);
  });

  it("is 360p on mobile data, whatever the screen", () => {
    expect(defaultReceiveQuality({ ...DESKTOP, cellular: true })).toBe("360p");
    expect(
      defaultReceiveQuality({ ...DESKTOP, coarsePointer: true, cellular: true }),
    ).toBe("360p");
    expect(defaultReceiveQuality({ ...DESKTOP, cellular: false })).toBe("auto");
  });
});

describe("the store on a changing connection", () => {
  const store = new Map<string, string>();

  /** A `navigator.connection` whose `change` the test can fire. */
  function connection(initial: { type?: string; effectiveType?: string }) {
    const listeners = new Set<() => void>();
    const conn = {
      ...initial,
      addEventListener: (_type: "change", listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: "change", listener: () => void) => {
        listeners.delete(listener);
      },
      change(next: { type?: string; effectiveType?: string }) {
        Object.assign(conn, next);
        for (const listener of listeners) {
          listener();
        }
      },
      listenerCount: () => listeners.size,
    };
    return conn;
  }

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
    resetReceiveQualityForTests();
    vi.unstubAllGlobals();
  });

  it("opens on 360p on cellular and says why", () => {
    vi.stubGlobal("navigator", {
      userAgent: "iPhone",
      connection: connection({ type: "cellular" }),
    });
    expect(getReceiveQuality()).toBe("360p");
    expect(getReceiveQualityReason()).toBe("cellular");
  });

  it("keeps a stored choice over the cellular default, with no reason line", () => {
    store.set("pqp:receive-quality", "720p");
    vi.stubGlobal("navigator", {
      userAgent: "iPhone",
      connection: connection({ type: "cellular" }),
    });
    expect(getReceiveQuality()).toBe("720p");
    expect(getReceiveQualityReason()).toBeNull();
  });

  it("follows the connection mid-call when nothing was chosen", () => {
    const conn = connection({ type: "wifi", effectiveType: "4g" });
    vi.stubGlobal("navigator", { userAgent: "iPhone", connection: conn });
    const seen: string[] = [];
    subscribeReceiveQuality((quality) => seen.push(quality));

    expect(getReceiveQuality()).toBe("720p");
    conn.change({ type: "cellular" });
    expect(getReceiveQuality()).toBe("360p");
    expect(getReceiveQualityReason()).toBe("cellular");
    conn.change({ type: "wifi" });
    expect(getReceiveQuality()).toBe("720p");
    expect(getReceiveQualityReason()).toBeNull();
    expect(seen).toEqual(["360p", "720p"]);
    // The default never writes storage: it is not a choice.
    expect(store.has("pqp:receive-quality")).toBe(false);
  });

  it("never moves an explicit pick, stored or made during the call", () => {
    const conn = connection({ type: "wifi" });
    vi.stubGlobal("navigator", { userAgent: "iPhone", connection: conn });
    const seen: string[] = [];
    subscribeReceiveQuality((quality) => seen.push(quality));

    getReceiveQuality();
    setReceiveQuality("1080p");
    conn.change({ type: "cellular" });
    expect(getReceiveQuality()).toBe("1080p");
    expect(getReceiveQualityReason()).toBeNull();
    expect(seen).toEqual(["1080p"]);
  });

  it("treats picking the default's own size as a choice", () => {
    const conn = connection({ type: "cellular" });
    vi.stubGlobal("navigator", { userAgent: "iPhone", connection: conn });
    expect(getReceiveQuality()).toBe("360p");
    setReceiveQuality("360p");
    expect(getReceiveQualityReason()).toBeNull();
    conn.change({ type: "wifi" });
    expect(getReceiveQuality()).toBe("360p");
  });

  it("listens once and stops on reset", () => {
    const conn = connection({ type: "wifi" });
    vi.stubGlobal("navigator", { userAgent: "iPhone", connection: conn });
    getReceiveQuality();
    getReceiveQuality();
    expect(conn.listenerCount()).toBe(1);
    resetReceiveQualityForTests();
    expect(conn.listenerCount()).toBe(0);
  });

  it("stands on the device default where the API does not exist", () => {
    vi.stubGlobal("navigator", { userAgent: "iPhone" });
    expect(getReceiveQuality()).toBe("720p");
    expect(getReceiveQualityReason()).toBeNull();
  });
});

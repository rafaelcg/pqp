import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushPeerVolumes,
  loadPeerVolumes,
  MAX_STORED_VOLUMES,
  parseStoredPeerVolumes,
  resetPeerVolumesForTests,
  savePeerVolumes,
} from "./peer-volume-pref";

/** vitest's `node` environment has no `localStorage`; just enough of it. */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

let storage: ReturnType<typeof fakeLocalStorage>;

beforeEach(() => {
  vi.useFakeTimers();
  storage = fakeLocalStorage();
  vi.stubGlobal("localStorage", storage);
  resetPeerVolumesForTests();
});

afterEach(() => {
  resetPeerVolumesForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("remembered per-person volumes (#1592)", () => {
  it("starts empty when nothing was saved", () => {
    expect(loadPeerVolumes()).toEqual({ peer: {}, screen: {} });
  });

  it("survives a reload: what was saved is what the next session loads", () => {
    savePeerVolumes({ peer: { alice: 0.4 }, screen: { alice: 0.2 } });
    vi.runAllTimers();
    resetPeerVolumesForTests();
    expect(loadPeerVolumes()).toEqual({
      peer: { alice: 0.4 },
      screen: { alice: 0.2 },
    });
  });

  it("keeps a muted-for-me person at zero", () => {
    savePeerVolumes({ peer: { bob: 0 }, screen: {} });
    vi.runAllTimers();
    expect(loadPeerVolumes().peer).toEqual({ bob: 0 });
  });

  it("debounces a drag into one write, the last value winning", () => {
    const setItem = vi.spyOn(storage, "setItem");
    for (const level of [0.9, 0.8, 0.7, 0.6]) {
      savePeerVolumes({ peer: { alice: level }, screen: {} });
    }
    expect(setItem).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(loadPeerVolumes().peer).toEqual({ alice: 0.6 });
  });

  it("flush writes a pending save at once", () => {
    savePeerVolumes({ peer: { alice: 0.5 }, screen: {} });
    flushPeerVolumes();
    expect(loadPeerVolumes().peer).toEqual({ alice: 0.5 });
  });

  it("drops a person put back at 100%, and the key once nobody is left", () => {
    savePeerVolumes({ peer: { alice: 0.5, bob: 0.3 }, screen: {} });
    vi.runAllTimers();
    savePeerVolumes({ peer: { alice: 1, bob: 0.3 }, screen: {} });
    vi.runAllTimers();
    expect(loadPeerVolumes().peer).toEqual({ bob: 0.3 });
    savePeerVolumes({ peer: { alice: 1, bob: 1 }, screen: {} });
    vi.runAllTimers();
    expect(storage.store.size).toBe(0);
  });

  it("ignores garbage instead of throwing", () => {
    expect(parseStoredPeerVolumes("{not json")).toEqual({ peer: {}, screen: {} });
    expect(parseStoredPeerVolumes('{"peer":[1,2]}')).toEqual({
      peer: {},
      screen: {},
    });
    expect(
      parseStoredPeerVolumes(
        JSON.stringify({
          peer: { a: 0.5, b: -1, c: 2, d: "0.4", e: null },
          screen: { a: 0.1 },
        }),
      ),
    ).toEqual({ peer: { a: 0.5 }, screen: { a: 0.1 } });
  });

  it("caps how many people it keeps, forgetting the oldest", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < MAX_STORED_VOLUMES + 50; i += 1) {
      many[`user${i}`] = 0.5;
    }
    savePeerVolumes({ peer: many, screen: {} });
    vi.runAllTimers();
    const kept = Object.keys(loadPeerVolumes().peer);
    expect(kept).toHaveLength(MAX_STORED_VOLUMES);
    // The newest are kept, the oldest forgotten.
    expect(kept).toContain(`user${MAX_STORED_VOLUMES + 49}`);
    expect(kept).not.toContain("user0");
  });

  it("works with no storage at all: nothing loads, nothing throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadPeerVolumes()).toEqual({ peer: {}, screen: {} });
    savePeerVolumes({ peer: { alice: 0.5 }, screen: {} });
    expect(() => vi.runAllTimers()).not.toThrow();
  });
});

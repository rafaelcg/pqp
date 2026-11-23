import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POPOUT_MAX_WIDTH_FRACTION } from "./popout-geometry";
import {
  DEFAULT_SHARE_POPOUT_PREF,
  parseSharePopoutPref,
  resetSharePopoutPrefForTests,
  setSharePopoutPref,
  sharePopoutPref,
} from "./share-popout-pref";

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
  resetSharePopoutPrefForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSharePopoutPrefForTests();
});

describe("parseSharePopoutPref", () => {
  it("reads a stored corner and size", () => {
    expect(parseSharePopoutPref('{"corner":"top-left","widthFraction":0.4}')).toEqual({
      corner: "top-left",
      widthFraction: 0.4,
    });
  });

  it("reads nothing, junk, or a bad field as the default for that field", () => {
    expect(parseSharePopoutPref(null)).toEqual(DEFAULT_SHARE_POPOUT_PREF);
    expect(parseSharePopoutPref("not json")).toEqual(DEFAULT_SHARE_POPOUT_PREF);
    expect(parseSharePopoutPref("null")).toEqual(DEFAULT_SHARE_POPOUT_PREF);
    expect(parseSharePopoutPref('{"corner":"middle","widthFraction":9}')).toEqual({
      corner: DEFAULT_SHARE_POPOUT_PREF.corner,
      widthFraction: POPOUT_MAX_WIDTH_FRACTION,
    });
  });
});

describe("share popout preference", () => {
  it("starts at the default and remembers a change across a reload", () => {
    expect(sharePopoutPref()).toEqual(DEFAULT_SHARE_POPOUT_PREF);
    setSharePopoutPref({ corner: "top-left" });
    setSharePopoutPref({ widthFraction: 0.45 });
    resetSharePopoutPrefForTests();
    expect(sharePopoutPref()).toEqual({ corner: "top-left", widthFraction: 0.45 });
  });

  it("still holds the choice for the session when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    resetSharePopoutPrefForTests();
    expect(sharePopoutPref()).toEqual(DEFAULT_SHARE_POPOUT_PREF);
    setSharePopoutPref({ corner: "top-right" });
    expect(sharePopoutPref().corner).toBe("top-right");
  });
});

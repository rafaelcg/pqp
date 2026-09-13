import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  hasSeenWatchDelayExplainer,
  markWatchDelayExplainerSeen,
  resetWatchDelayExplainerForTests,
} from "./watch-delay-explainer";

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the watch-party delay explainer", () => {
  it("has not been seen before anybody watches anything", () => {
    expect(hasSeenWatchDelayExplainer()).toBe(false);
  });

  it("stays dismissed once marked seen, across reads", () => {
    markWatchDelayExplainerSeen();
    expect(hasSeenWatchDelayExplainer()).toBe(true);
    expect(hasSeenWatchDelayExplainer()).toBe(true);
  });

  it("can be forgotten for a fresh test", () => {
    markWatchDelayExplainerSeen();
    resetWatchDelayExplainerForTests();
    expect(hasSeenWatchDelayExplainer()).toBe(false);
  });

  it("defaults to already-seen when storage is unavailable, rather than nagging every watch", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("no storage here");
      },
      setItem: () => {
        throw new Error("no storage here");
      },
    });
    expect(hasSeenWatchDelayExplainer()).toBe(true);
  });
});

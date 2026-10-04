import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoHideStageControls,
  resetAutoHideStageControlsForTests,
  setAutoHideStageControls,
  subscribeAutoHideStageControls,
} from "./stage-controls-pref";

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
  resetAutoHideStageControlsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAutoHideStageControlsForTests();
});

describe("the auto-hide controls preference", () => {
  it("is on before anybody chooses", () => {
    expect(autoHideStageControls()).toBe(true);
  });

  it("remembers an off across a reload", () => {
    setAutoHideStageControls(false);
    resetAutoHideStageControlsForTests();
    expect(autoHideStageControls()).toBe(false);
  });

  it("tells subscribers only when the value changes", () => {
    const seen: boolean[] = [];
    subscribeAutoHideStageControls((value) => seen.push(value));
    setAutoHideStageControls(true);
    setAutoHideStageControls(false);
    setAutoHideStageControls(false);
    setAutoHideStageControls(true);
    expect(seen).toEqual([false, true]);
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
    resetAutoHideStageControlsForTests();
    expect(autoHideStageControls()).toBe(true);
    setAutoHideStageControls(false);
    expect(autoHideStageControls()).toBe(false);
  });
});

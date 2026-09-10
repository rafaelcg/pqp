import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hideScreenPreview,
  resetHideScreenPreviewForTests,
  setHideScreenPreview,
  subscribeHideScreenPreview,
} from "./screen-preview-pref";

/**
 * The suite runs under vitest's `node` environment, which has no
 * `localStorage` global at all. Just enough of the real API for the module.
 */
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
  resetHideScreenPreviewForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHideScreenPreviewForTests();
});

describe("the remembered preview preference", () => {
  it("shows the preview before anybody chooses", () => {
    expect(hideScreenPreview()).toBe(false);
  });

  it("survives a reload", () => {
    setHideScreenPreview(true);
    resetHideScreenPreviewForTests();
    expect(hideScreenPreview()).toBe(true);
  });

  it("stores under a key the rest of the app will recognise", () => {
    setHideScreenPreview(true);
    expect(localStorage.getItem("pqp:hide-screen-preview")).toBe("1");
    setHideScreenPreview(false);
    expect(localStorage.getItem("pqp:hide-screen-preview")).toBe("0");
  });

  it("ignores junk in storage", () => {
    localStorage.setItem("pqp:hide-screen-preview", "sometimes");
    expect(hideScreenPreview()).toBe(false);
  });

  it("tells subscribers when it changes, and only when it changes", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeHideScreenPreview((value) => seen.push(value));
    setHideScreenPreview(true);
    setHideScreenPreview(true);
    setHideScreenPreview(false);
    unsubscribe();
    setHideScreenPreview(true);
    expect(seen).toEqual([true, false]);
  });
});

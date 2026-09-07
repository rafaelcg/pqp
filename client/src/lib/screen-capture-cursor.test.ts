import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canControlShareCursor,
  cursorConstraintFor,
  cursorRidesAlong,
  DEFAULT_SHARE_CURSOR,
  getShareCursor,
  parseShareCursor,
  readStoredShareCursor,
  resetShareCursorForTests,
  setShareCursor,
  subscribeShareCursor,
} from "./screen-capture-cursor";

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
  resetShareCursorForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetShareCursorForTests();
});

describe("the cursor constraint we send", () => {
  it("maps the two states onto the spec's values", () => {
    expect(cursorConstraintFor("hide")).toBe("never");
    expect(cursorConstraintFor("show")).toBe("always");
  });
});

describe("whether the engine can be promised anything", () => {
  it("is false on every engine shipping today", () => {
    // Measured, not assumed: Chromium 141, Firefox 153 and WebKit 26.5 all
    // return a getSupportedConstraints() with no `cursor` in it, and none of
    // the three has the member in its IDL. This is what keeps a live,
    // mid-share change of the preference from claiming to have worked.
    expect(canControlShareCursor({ displaySurface: true })).toBe(false);
  });

  it("is true only when the engine names the constraint", () => {
    expect(canControlShareCursor({ cursor: true })).toBe(true);
  });

  it("treats a browser with no mediaDevices as no", () => {
    expect(canControlShareCursor({})).toBe(false);
  });
});

describe("cursorRidesAlong", () => {
  const asked = { hideCursor: true, canControl: false };

  it("is true for a screen share on an engine that cannot hide it", () => {
    expect(cursorRidesAlong({ ...asked, displaySurface: "monitor" })).toBe(
      true,
    );
  });

  it("is true for a window share, which is the reported case", () => {
    // A film in one window, a game in another, and the pointer drawn over the
    // film. The whole reason this exists.
    expect(cursorRidesAlong({ ...asked, displaySurface: "window" })).toBe(true);
  });

  it("is false for a tab share, which carries no pointer at all", () => {
    expect(cursorRidesAlong({ ...asked, displaySurface: "browser" })).toBe(
      false,
    );
  });

  it("is false when nobody asked for the pointer to be left out", () => {
    // Presenting. The pointer is the content, and a warning here would be
    // noise on every share anybody ever starts.
    expect(
      cursorRidesAlong({
        hideCursor: false,
        canControl: false,
        displaySurface: "monitor",
      }),
    ).toBe(false);
  });

  it("is false when the engine honoured the constraint", () => {
    expect(
      cursorRidesAlong({
        hideCursor: true,
        canControl: true,
        displaySurface: "monitor",
      }),
    ).toBe(false);
  });

  it("is false when the surface is unknown", () => {
    // Same rule as capturesSystemAudio: the engines that omit displaySurface
    // are not the ones this is about, and crying wolf trains the warning out.
    expect(cursorRidesAlong({ ...asked })).toBe(false);
    expect(cursorRidesAlong({ ...asked, displaySurface: null })).toBe(false);
  });
});

describe("the remembered preference", () => {
  it("shows the cursor before anybody chooses", () => {
    expect(DEFAULT_SHARE_CURSOR).toBe("show");
    expect(getShareCursor()).toBe("show");
  });

  it("survives a reload, unlike the system-audio opt-in beside it", () => {
    // The point of the whole feature for the person who reported it: he
    // shares a film every night and should not re-arm this every night.
    setShareCursor("hide");
    resetShareCursorForTests();
    expect(getShareCursor()).toBe("hide");
    expect(readStoredShareCursor()).toBe("hide");
  });

  it("stores under a key the rest of the app will recognise", () => {
    setShareCursor("hide");
    expect(localStorage.getItem("pqp:share-cursor")).toBe("hide");
  });

  it("ignores junk in storage", () => {
    localStorage.setItem("pqp:share-cursor", "sometimes");
    expect(readStoredShareCursor()).toBeNull();
    expect(getShareCursor()).toBe("show");
  });

  it("only accepts the two states", () => {
    expect(parseShareCursor("hide")).toBe("hide");
    expect(parseShareCursor("show")).toBe("show");
    expect(parseShareCursor("motion")).toBeNull();
    expect(parseShareCursor(null)).toBeNull();
    expect(parseShareCursor(7)).toBeNull();
  });

  it("tells subscribers when it changes, and only when it changes", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeShareCursor((value) => seen.push(value));
    setShareCursor("hide");
    setShareCursor("hide");
    setShareCursor("show");
    unsubscribe();
    setShareCursor("hide");
    expect(seen).toEqual(["hide", "show"]);
  });
});

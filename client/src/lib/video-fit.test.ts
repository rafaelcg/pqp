import { afterEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
});

const {
  VIDEO_FIT_DEFAULT,
  loadVideoFit,
  saveVideoFit,
  toggledVideoFit,
  videoFitClass,
} = await import("./video-fit");

describe("the defaults are what the stage already drew", () => {
  /**
   * The whole reason there are two values and not one. Shipping this must not
   * change a single first render: a face was cropped and a shared screen was
   * whole before there was a toggle, and both still are.
   */
  it("crops a camera and keeps a shared screen whole", () => {
    expect(VIDEO_FIT_DEFAULT).toEqual({ camera: "cover", screen: "contain", watch: "contain" });
    expect(videoFitClass(VIDEO_FIT_DEFAULT.camera)).toBe("object-cover");
    expect(videoFitClass(VIDEO_FIT_DEFAULT.screen)).toBe("object-contain");
  });

  it("has exactly two answers and flips between them", () => {
    expect(toggledVideoFit("cover")).toBe("contain");
    expect(toggledVideoFit("contain")).toBe("cover");
  });
});

describe("stored preference", () => {
  afterEach(() => store.clear());

  it("defaults when nothing is stored", () => {
    expect(loadVideoFit()).toEqual(VIDEO_FIT_DEFAULT);
  });

  it("survives a reload", () => {
    saveVideoFit({ camera: "contain", screen: "cover", watch: "contain" });
    expect(loadVideoFit()).toEqual({ camera: "contain", screen: "cover", watch: "contain" });
  });

  it("keeps the two kinds apart", () => {
    saveVideoFit({ camera: "contain", screen: "contain", watch: "contain" });
    expect(loadVideoFit().camera).toBe("contain");
    saveVideoFit({ ...loadVideoFit(), camera: "cover" });
    // Changing cameras left the screen answer alone, which is the point of
    // storing two.
    expect(loadVideoFit()).toEqual({ camera: "cover", screen: "contain", watch: "contain" });
  });

  it("falls back per field rather than throwing the lot away", () => {
    store.set("pqp:video-fit", JSON.stringify({ camera: "sideways" }));
    expect(loadVideoFit()).toEqual(VIDEO_FIT_DEFAULT);
  });

  it("survives half-written JSON", () => {
    store.set("pqp:video-fit", "{ not json");
    expect(loadVideoFit()).toEqual(VIDEO_FIT_DEFAULT);
  });
});

describe("the watch stage's own answer", () => {
  it("starts whole, like a shared screen and unlike a camera", () => {
    // A film letterboxed is a film; a film cropped has lost its edges. Fit is
    // the safe default and the one Rafael asked for.
    expect(VIDEO_FIT_DEFAULT.watch).toBe("contain");
  });

  it("does not move when the call's screen tiles are flipped", () => {
    // The point of a third kind. Choosing "fill" on a grid tile mid-call must
    // not silently crop the watch party somebody opens afterwards.
    saveVideoFit({ camera: "cover", screen: "cover", watch: "contain" });
    expect(loadVideoFit().watch).toBe("contain");
    expect(loadVideoFit().screen).toBe("cover");
  });
});

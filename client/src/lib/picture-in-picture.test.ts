import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isInPictureInPicture,
  pictureInPictureSupport,
  togglePictureInPicture,
  watchPictureInPicture,
  type PipDocument,
  type PipVideo,
} from "./picture-in-picture";

/**
 * Fake elements with just the surface each platform exposes, so the support
 * matrix (Chromium, old Safari, Firefox) is pinned without a browser.
 */
function fakeVideo(overrides: Partial<PipVideo> = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const video = {
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
    ...overrides,
  };
  return video;
}

function standardPlatform() {
  const doc: PipDocument & { pictureInPictureElement: unknown } = {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    exitPictureInPicture: vi.fn(async () => {
      const left = doc.pictureInPictureElement as ReturnType<typeof fakeVideo>;
      doc.pictureInPictureElement = null;
      left?.fire("leavepictureinpicture");
    }),
  };
  const makeVideo = () => {
    const video: ReturnType<typeof fakeVideo> = fakeVideo({
      requestPictureInPicture: vi.fn(async () => {
        const previous = doc.pictureInPictureElement as
          | ReturnType<typeof fakeVideo>
          | null;
        doc.pictureInPictureElement = video;
        previous?.fire("leavepictureinpicture");
        video.fire("enterpictureinpicture");
      }),
    });
    return video;
  };
  return { doc, makeVideo };
}

function safariVideo() {
  const video: ReturnType<typeof fakeVideo> & { webkitPresentationMode: string } =
    fakeVideo({
      webkitPresentationMode: "inline",
      webkitSupportsPresentationMode: (mode: string) =>
        mode === "picture-in-picture",
      webkitSetPresentationMode: (mode: string) => {
        video.webkitPresentationMode = mode;
        video.fire("webkitpresentationmodechanged");
      },
    }) as never;
  return video;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pictureInPictureSupport", () => {
  it("is the standard API on Chromium and current Safari", () => {
    const { doc, makeVideo } = standardPlatform();
    expect(pictureInPictureSupport(makeVideo(), doc)).toBe("standard");
  });

  it("is Safari's presentation mode when the standard API is absent", () => {
    expect(pictureInPictureSupport(safariVideo(), {})).toBe("webkit");
  });

  it("is none on Firefox, which leaves its own overlay toggle in charge", () => {
    expect(pictureInPictureSupport(fakeVideo(), {})).toBe("none");
  });

  it("is none when the document disables it (a permissions policy, say)", () => {
    const { makeVideo } = standardPlatform();
    expect(
      pictureInPictureSupport(makeVideo(), { pictureInPictureEnabled: false }),
    ).toBe("none");
  });

  it("is none on an element that opted out", () => {
    const { doc, makeVideo } = standardPlatform();
    const video = makeVideo();
    video.disablePictureInPicture = true;
    expect(pictureInPictureSupport(video, doc)).toBe("none");
  });

  it("is none with no element or no document", () => {
    expect(pictureInPictureSupport(null, {})).toBe("none");
    expect(pictureInPictureSupport(fakeVideo(), undefined)).toBe("none");
  });
});

describe("togglePictureInPicture", () => {
  it("enters, then leaves on the second press", async () => {
    const { doc, makeVideo } = standardPlatform();
    const video = makeVideo();
    expect(await togglePictureInPicture(video, doc)).toBe("entered");
    expect(isInPictureInPicture(video, doc)).toBe(true);
    expect(await togglePictureInPicture(video, doc)).toBe("exited");
    expect(isInPictureInPicture(video, doc)).toBe(false);
  });

  it("swaps the window to the second share instead of opening two", async () => {
    const { doc, makeVideo } = standardPlatform();
    const first = makeVideo();
    const second = makeVideo();
    await togglePictureInPicture(first, doc);
    expect(await togglePictureInPicture(second, doc)).toBe("entered");
    expect(isInPictureInPicture(first, doc)).toBe(false);
    expect(isInPictureInPicture(second, doc)).toBe(true);
    expect(doc.exitPictureInPicture).not.toHaveBeenCalled();
  });

  it("drives Safari's presentation mode both ways", async () => {
    const video = safariVideo();
    expect(await togglePictureInPicture(video, {})).toBe("entered");
    expect(video.webkitPresentationMode).toBe("picture-in-picture");
    expect(await togglePictureInPicture(video, {})).toBe("exited");
    expect(video.webkitPresentationMode).toBe("inline");
  });

  it("reports a refusal instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { doc } = standardPlatform();
    const video = fakeVideo({
      requestPictureInPicture: () =>
        Promise.reject(new DOMException("no gesture", "NotAllowedError")),
    });
    expect(await togglePictureInPicture(video, doc)).toBe("refused");
    expect(warn).toHaveBeenCalled();
  });

  it("does nothing where there is no API", async () => {
    expect(await togglePictureInPicture(fakeVideo(), {})).toBe("unsupported");
  });
});

describe("watchPictureInPicture", () => {
  it("reports each transition once, including being swapped out", async () => {
    const { doc, makeVideo } = standardPlatform();
    const first = makeVideo();
    const second = makeVideo();
    const seen: boolean[] = [];
    watchPictureInPicture(first, doc, (inPip) => seen.push(inPip));
    await togglePictureInPicture(first, doc);
    first.fire("enterpictureinpicture");
    await togglePictureInPicture(second, doc);
    expect(seen).toEqual([true, false]);
  });

  it("follows Safari's presentation mode", async () => {
    const video = safariVideo();
    const seen: boolean[] = [];
    watchPictureInPicture(video, {}, (inPip) => seen.push(inPip));
    await togglePictureInPicture(video, {});
    await togglePictureInPicture(video, {});
    expect(seen).toEqual([true, false]);
  });

  it("removes every listener it added", () => {
    const { doc, makeVideo } = standardPlatform();
    const video = makeVideo();
    const stop = watchPictureInPicture(video, doc, () => {});
    expect(video.listenerCount()).toBeGreaterThan(0);
    stop();
    expect(video.listenerCount()).toBe(0);
  });
});

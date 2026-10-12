import { afterEach, describe, expect, it, vi } from "vitest";
import {
  afterPictureInPictureRequest,
  isInPictureInPicture,
  pictureInPictureOnThisDevice,
  pictureInPictureSupport,
  registerAutoPictureInPicture,
  togglePictureInPicture,
  watchPictureInPicture,
  type PipDocument,
  type PipMediaSession,
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

describe("afterPictureInPictureRequest", () => {
  it("checks now, and again once a request still in flight lands", async () => {
    const { doc } = standardPlatform();
    let land: () => void = () => {};
    const video: ReturnType<typeof fakeVideo> = fakeVideo({
      requestPictureInPicture: () =>
        new Promise<void>((resolve) => {
          land = () => {
            doc.pictureInPictureElement = video;
            resolve();
          };
        }),
    });
    const entering = togglePictureInPicture(video, doc);
    // The share goes away before the browser has set the element.
    const seen: boolean[] = [];
    afterPictureInPictureRequest(video, () => {
      seen.push(isInPictureInPicture(video, doc));
      if (isInPictureInPicture(video, doc)) {
        void togglePictureInPicture(video, doc);
      }
    });
    expect(seen).toEqual([false]);
    land();
    expect(await entering).toBe("entered");
    await Promise.resolve();
    expect(seen).toEqual([false, true]);
    expect(doc.exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(isInPictureInPicture(video, doc)).toBe(false);
  });

  it("checks once when nothing is in flight", async () => {
    const { doc, makeVideo } = standardPlatform();
    const video = makeVideo();
    await togglePictureInPicture(video, doc);
    const check = vi.fn();
    afterPictureInPictureRequest(video, check);
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("does not check again after a refused request, and does not throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { doc } = standardPlatform();
    let refuse: () => void = () => {};
    const video = fakeVideo({
      requestPictureInPicture: () =>
        new Promise<void>((_resolve, reject) => {
          refuse = () => reject(new DOMException("gone", "InvalidStateError"));
        }),
    });
    const entering = togglePictureInPicture(video, doc);
    const check = vi.fn();
    afterPictureInPictureRequest(video, check);
    refuse();
    expect(await entering).toBe("refused");
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
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

function fakeMediaSession(known = true) {
  const handlers = new Map<string, ((details?: unknown) => void) | null>();
  const session: PipMediaSession & {
    handlers: typeof handlers;
    fire: (action: string) => void;
  } = {
    handlers,
    setActionHandler(action, handler) {
      if (!known) {
        throw new TypeError(`unknown action ${action}`);
      }
      handlers.set(action, handler);
    },
    fire(action) {
      handlers.get(action)?.({ action, reason: "contentoccluded" });
    },
  };
  return session;
}

describe("registerAutoPictureInPicture", () => {
  it("opens PiP on the share when the browser asks, and unregisters on cleanup", async () => {
    const { doc, makeVideo } = standardPlatform();
    const share = makeVideo();
    const session = fakeMediaSession();
    const stop = registerAutoPictureInPicture(session, share, doc);
    expect(session.handlers.get("enterpictureinpicture")).toBeTypeOf("function");

    session.fire("enterpictureinpicture");
    await Promise.resolve();
    expect(share.requestPictureInPicture).toHaveBeenCalledTimes(1);
    expect(doc.pictureInPictureElement).toBe(share);

    stop();
    expect(session.handlers.get("enterpictureinpicture")).toBeNull();
  });

  it("leaves a window the viewer already opened where it is", async () => {
    const { doc, makeVideo } = standardPlatform();
    const main = makeVideo();
    const other = makeVideo();
    await other.requestPictureInPicture!();
    const session = fakeMediaSession();
    registerAutoPictureInPicture(session, main, doc);

    session.fire("enterpictureinpicture");
    await Promise.resolve();
    expect(main.requestPictureInPicture).not.toHaveBeenCalled();
    expect(doc.pictureInPictureElement).toBe(other);
  });

  it("registers nothing where the browser does not know the action", () => {
    const { doc, makeVideo } = standardPlatform();
    const share = makeVideo();
    const stop = registerAutoPictureInPicture(fakeMediaSession(false), share, doc);
    expect(() => stop()).not.toThrow();
  });

  it("registers nothing without the standard API or a media session", () => {
    const session = fakeMediaSession();
    registerAutoPictureInPicture(session, safariVideo(), {});
    const { doc, makeVideo } = standardPlatform();
    registerAutoPictureInPicture(undefined, makeVideo(), doc);
    expect(session.handlers.size).toBe(0);
  });

  it("reports a refused request instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { doc } = standardPlatform();
    const share = fakeVideo({
      requestPictureInPicture: vi.fn(async () => {
        throw new DOMException("not allowed", "NotAllowedError");
      }),
    });
    const session = fakeMediaSession();
    registerAutoPictureInPicture(session, share, doc);
    session.fire("enterpictureinpicture");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalled();
  });
});

describe("pictureInPictureOnThisDevice", () => {
  const desktop = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) pqp/1.0.0 Chrome/140.0.0.0 Electron/44.0.0 Safari/537.36",
  ];
  const mobile = [
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  ];

  it.each(desktop)("offers PiP on a desktop browser or the desktop app: %s", (userAgent) => {
    expect(pictureInPictureOnThisDevice({ userAgent, maxTouchPoints: 0 })).toBe(true);
  });

  it.each(mobile)("hides PiP on a phone or tablet: %s", (userAgent) => {
    expect(pictureInPictureOnThisDevice({ userAgent, maxTouchPoints: 5 })).toBe(false);
  });

  it("hides PiP on an iPad that reports a Mac user agent", () => {
    expect(
      pictureInPictureOnThisDevice({ userAgent: desktop[1], maxTouchPoints: 5 }),
    ).toBe(false);
  });

  it("trusts the browser's own mobile answer over the user agent", () => {
    expect(
      pictureInPictureOnThisDevice({
        userAgent: desktop[2],
        userAgentData: { mobile: true, platform: "Android" },
      }),
    ).toBe(false);
  });
});

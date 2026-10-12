// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usePictureInPicture,
  usePictureInPictureKey,
} from "./use-picture-in-picture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * A share that goes away while its PiP request is still in flight must not
 * leave a window open once the request lands (Farol on #1153). jsdom has no
 * PiP, so the document and the element get the standard API by hand, with a
 * request that lands only when the test says so.
 */
let pipElement: Element | null = null;
const exitPictureInPicture = vi.fn(async () => {
  pipElement = null;
});
let land: () => void = () => {};
let toggle: () => void = () => {};

/** A request that lands, putting `video` in PiP, when the test calls `land`. */
function pendingRequest(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve) => {
    land = () => {
      pipElement = video;
      resolve();
    };
  });
}

function Share({ source, mounted }: { source: unknown; mounted: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  toggle = usePictureInPicture(ref, source).toggle;
  return mounted ? <video ref={ref} /> : null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  pipElement = null;
  exitPictureInPicture.mockClear();
  Object.defineProperty(document, "pictureInPictureEnabled", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(document, "pictureInPictureElement", {
    configurable: true,
    get: () => pipElement,
  });
  Object.defineProperty(document, "exitPictureInPicture", {
    configurable: true,
    value: exitPictureInPicture,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "requestPictureInPicture", {
    configurable: true,
    value(this: HTMLVideoElement) {
      return pendingRequest(this);
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (document as { pictureInPictureEnabled?: boolean })
    .pictureInPictureEnabled;
  delete (document as { pictureInPictureElement?: unknown })
    .pictureInPictureElement;
  delete (document as { exitPictureInPicture?: unknown }).exitPictureInPicture;
  delete (HTMLVideoElement.prototype as { requestPictureInPicture?: unknown })
    .requestPictureInPicture;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("usePictureInPicture with a request in flight", () => {
  it("closes the window when the tile unmounted before the request landed", async () => {
    const stream = {};
    act(() => root!.render(<Share source={stream} mounted />));
    act(() => toggle());
    act(() => root!.render(<Share source={null} mounted={false} />));
    await settle();
    expect(exitPictureInPicture).not.toHaveBeenCalled();

    land();
    await settle();
    expect(exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(pipElement).toBeNull();
  });

  it("closes the window when the share ended before the request landed", async () => {
    const stream = {};
    act(() => root!.render(<Share source={stream} mounted />));
    act(() => toggle());
    act(() => root!.render(<Share source={null} mounted />));
    await settle();

    land();
    await settle();
    expect(exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(pipElement).toBeNull();
  });

  it("keeps the window when the share came back before the request landed", async () => {
    const stream = {};
    act(() => root!.render(<Share source={stream} mounted />));
    act(() => toggle());
    act(() => root!.render(<Share source={null} mounted />));
    act(() => root!.render(<Share source={{}} mounted />));
    await settle();

    land();
    await settle();
    expect(exitPictureInPicture).not.toHaveBeenCalled();
    expect(pipElement).not.toBeNull();
  });
});

describe("usePictureInPictureKey", () => {
  let seen: string | null = null;
  function Keyed({ videos }: { videos: ReadonlyMap<string, HTMLVideoElement> }) {
    seen = usePictureInPictureKey(videos);
    return null;
  }

  it("names the share holding the window as it opens, swaps and closes", () => {
    const a = document.createElement("video");
    const b = document.createElement("video");
    const videos = new Map([
      ["a", a],
      ["b", b],
    ]);
    act(() => root!.render(<Keyed videos={videos} />));
    expect(seen).toBeNull();

    act(() => {
      pipElement = a;
      a.dispatchEvent(new Event("enterpictureinpicture"));
    });
    expect(seen).toBe("a");

    act(() => {
      pipElement = b;
      a.dispatchEvent(new Event("leavepictureinpicture"));
      b.dispatchEvent(new Event("enterpictureinpicture"));
    });
    expect(seen).toBe("b");

    act(() => {
      pipElement = null;
      b.dispatchEvent(new Event("leavepictureinpicture"));
    });
    expect(seen).toBeNull();
  });

  it("reads a window already open when the share registers", () => {
    const a = document.createElement("video");
    pipElement = a;
    act(() => root!.render(<Keyed videos={new Map([["a", a]])} />));
    expect(seen).toBe("a");
  });
});

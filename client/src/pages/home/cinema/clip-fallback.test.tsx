// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Clip, type ClipSources } from "./clip";

/*
 * What a clip draws when its video fails. Chrome's hardware VP9 decoder gives
 * up on some WebMs (MEDIA_ERR_DECODE at the first frame, more often with
 * several playing at once), and a decode error never moves on to the next
 * <source> by itself. So a WebM that fails to decode is swapped for its MP4 on
 * a fresh element, and only an MP4 failing too (or any other error) leaves the
 * still. jsdom plays nothing, so each failure is staged on the element: its
 * `error` and `currentSrc`, then the event.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABEL = "Bia shares her screen";
const FILES: ClipSources = {
  webm: "/media/home/share.webm",
  mp4: "/media/home/share.mp4",
  poster: "/media/home/share.webp",
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(src: ClipSources = FILES) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Clip src={src} label={LABEL} controls={false} />);
  });
}

function videoEl(): HTMLVideoElement | null {
  return host?.querySelector("video") ?? null;
}

function sources(el: HTMLVideoElement): { src: string | null; type: string | null }[] {
  return [...el.querySelectorAll("source")].map((s) => ({ src: s.getAttribute("src"), type: s.getAttribute("type") }));
}

/** The still under the video; its alt is the label once no video is drawn. */
function still(): HTMLImageElement | null {
  return host?.querySelector("img") ?? null;
}

/** A media error on the element, as the browser reports one. */
async function failVideo(el: HTMLVideoElement, code: number, file: string) {
  Object.defineProperty(el, "error", { configurable: true, value: { code, message: "" } });
  Object.defineProperty(el, "currentSrc", { configurable: true, value: new URL(file, location.href).href });
  await act(async () => {
    el.dispatchEvent(new Event("error"));
  });
}

beforeEach(() => {
  // jsdom has no matchMedia: a wide screen, a mouse, no reduced motion.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  // jsdom does not implement playback; the clip only needs the promise.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("Clip media fallback", () => {
  it("plays WebM first, then MP4", async () => {
    await mount();
    const el = videoEl();
    expect(el).not.toBeNull();
    expect(sources(el!)).toEqual([
      { src: FILES.webm, type: "video/webm" },
      { src: FILES.mp4, type: "video/mp4" },
    ]);
  });

  it("swaps a WebM that fails to decode for its MP4, on a new element", async () => {
    await mount();
    const first = videoEl()!;
    await failVideo(first, 3, FILES.webm!);

    const second = videoEl();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(sources(second!)).toEqual([{ src: FILES.mp4, type: "video/mp4" }]);
    expect(still()?.getAttribute("alt")).toBe("");
  });

  it("keeps the still when the MP4 fails too", async () => {
    await mount();
    await failVideo(videoEl()!, 3, FILES.webm!);
    await failVideo(videoEl()!, 3, FILES.mp4!);

    expect(videoEl()).toBeNull();
    expect(still()?.getAttribute("src")).toBe(FILES.poster);
    expect(still()?.getAttribute("alt")).toBe(LABEL);
  });

  it("keeps the still when the MP4 fails to load after the swap", async () => {
    await mount();
    await failVideo(videoEl()!, 3, FILES.webm!);
    const last = videoEl()!.querySelector("source")!;
    await act(async () => {
      last.dispatchEvent(new Event("error"));
    });

    expect(videoEl()).toBeNull();
    expect(still()?.getAttribute("alt")).toBe(LABEL);
  });

  it.each([
    ["a network error", 2],
    ["an unsupported source", 4],
  ])("keeps the still on %s, without trying the MP4", async (_, code) => {
    await mount();
    await failVideo(videoEl()!, code, FILES.webm!);

    expect(videoEl()).toBeNull();
    expect(still()?.getAttribute("alt")).toBe(LABEL);
  });

  it("keeps the still when a decode error comes from the MP4", async () => {
    // The WebM failed to load, so the browser moved on to the MP4 by itself.
    await mount();
    await failVideo(videoEl()!, 3, FILES.mp4!);

    expect(videoEl()).toBeNull();
    expect(still()?.getAttribute("alt")).toBe(LABEL);
  });

  it("keeps the still when a WebM with no MP4 fails to decode", async () => {
    await mount({ webm: FILES.webm, poster: FILES.poster });
    await failVideo(videoEl()!, 3, FILES.webm!);

    expect(videoEl()).toBeNull();
    expect(still()?.getAttribute("alt")).toBe(LABEL);
  });

  it("keeps the still when the last source fails to load", async () => {
    await mount();
    const sourcesNow = videoEl()!.querySelectorAll("source");
    await act(async () => {
      sourcesNow[sourcesNow.length - 1].dispatchEvent(new Event("error"));
    });

    expect(videoEl()).toBeNull();
    expect(still()?.getAttribute("alt")).toBe(LABEL);
  });
});

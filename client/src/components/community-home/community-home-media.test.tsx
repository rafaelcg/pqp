// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CommunityHomeMedia } from "@pqp/shared";
import { UnlockedMedia, formatVideoDuration } from "./community-home-media";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const video: CommunityHomeMedia = {
  kind: "video",
  name: "lancamento.mp4",
  contentType: "video/mp4",
  byteSize: 17 * 1024 * 1024,
  url: "https://bucket.example/lancamento.mp4?sig=1",
  youtubeUrl: null,
  twitchUrl: null,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(media: CommunityHomeMedia) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<UnlockedMedia media={media} flush />);
  });
  return host;
}

// jsdom has no media pipeline: give the element the numbers a browser would.
async function loadMetadata(el: HTMLVideoElement, w: number, h: number, duration: number) {
  Object.defineProperty(el, "videoWidth", { value: w, configurable: true });
  Object.defineProperty(el, "videoHeight", { value: h, configurable: true });
  Object.defineProperty(el, "duration", { value: duration, configurable: true });
  await act(async () => {
    el.dispatchEvent(new Event("loadedmetadata"));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("formatVideoDuration", () => {
  it("reads as m:ss", () => {
    expect(formatVideoDuration(39.2)).toBe("0:39");
    expect(formatVideoDuration(61)).toBe("1:01");
    expect(formatVideoDuration(0)).toBe("0:00");
  });
});

describe("the Baú video", () => {
  it("shows a poster with a play button and no filename caption", async () => {
    const el = await mount(video);
    expect(el.querySelector("[data-home-video-play]")).not.toBeNull();
    expect(el.textContent).not.toContain("lancamento.mp4");
    // No native controls until somebody presses play.
    expect(el.querySelector("video")!.hasAttribute("controls")).toBe(false);
  });

  it("a landscape video fills the card at its own shape", async () => {
    const el = await mount(video);
    await loadMetadata(el.querySelector("video")!, 1920, 1080, 39.2);
    const box = el.querySelector<HTMLElement>("[data-home-video]")!;
    expect(box.dataset.homeVideo).toBe("fill");
    expect(box.style.aspectRatio.replace(/\s/g, "")).toBe("1920/1080");
    expect(el.textContent).toContain("0:39");
  });

  it("a tall video keeps the fixed box and gets the blurred sides", async () => {
    const el = await mount(video);
    await loadMetadata(el.querySelector("video")!, 1080, 1920, 12);
    const box = el.querySelector<HTMLElement>("[data-home-video]")!;
    expect(box.dataset.homeVideo).toBe("fit");
    expect(box.querySelector("canvas")).not.toBeNull();
  });

  it("draws its own bar: play turns into pause, never the browser's controls", async () => {
    const el = await mount(video);
    const v = el.querySelector("video")!;
    v.play = () => {
      v.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    const play = el.querySelector<HTMLButtonElement>("[data-home-video-play]")!;
    expect(play.getAttribute("aria-label")).toBe("Play the video");
    expect(el.textContent).toContain("Watch");
    await act(async () => {
      play.click();
    });
    expect(el.querySelector("[data-home-video-play]")!.getAttribute("aria-label")).toBe("Pause");
    expect(v.hasAttribute("controls")).toBe(false);
    expect(el.querySelector("[data-home-video-bar] input[type=range]")).not.toBeNull();
  });

  it("the sound button follows the video's own muted state", async () => {
    const el = await mount(video);
    const v = el.querySelector("video")!;
    const bar = el.querySelector("[data-home-video-bar]")!;
    expect(bar.querySelector("[aria-label='Mute']")).not.toBeNull();
    await act(async () => {
      bar.querySelector<HTMLButtonElement>("[aria-label='Mute']")!.click();
      v.dispatchEvent(new Event("volumechange"));
    });
    expect(v.muted).toBe(true);
    expect(bar.querySelector("[aria-label='Unmute']")).not.toBeNull();
  });
});

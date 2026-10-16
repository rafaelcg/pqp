import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Story } from "@pqp/shared";
import {
  MAX_CONCURRENT,
  REMEMBER_STORIES_MS,
  StoryPreloader,
  assetsOfStory,
  rememberStories,
  rememberedStory,
  resetPreloadForTests,
  type ImageLike,
  type PreloadAsset,
  type PreloadEnv,
  type VideoLike,
} from "./preload";

class FakeImage implements ImageLike {
  decoding = "";
  src = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decode = vi.fn(async () => undefined);
  /** The network answers. */
  finish() {
    this.onload?.();
  }
}

class FakeVideo implements VideoLike {
  preload = "";
  muted = false;
  playsInline = false;
  src = "";
  readyState = 0;
  load = vi.fn();
  pause = vi.fn();
  private readonly listeners = new Map<string, Set<() => void>>();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

function harness(saveData = false) {
  const images: FakeImage[] = [];
  const videos: FakeVideo[] = [];
  const env: PreloadEnv = {
    createImage: () => {
      const image = new FakeImage();
      images.push(image);
      return image;
    },
    createVideo: () => {
      const video = new FakeVideo();
      videos.push(video);
      return video;
    },
    saveData: () => saveData,
  };
  return { preloader: new StoryPreloader(env), images, videos };
}

const img = (url: string): PreloadAsset => ({ key: `image:${url}`, kind: "image", url });
const vid = (url: string): PreloadAsset => ({ key: `video:${url}`, kind: "video", url });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function story(id: string, extra: Partial<Story> = {}): Story {
  return {
    id,
    author: { id: `a-${id}`, displayName: "A", avatarUrl: `https://cdn/avatar-${id}.png`, handle: null },
    kind: "image",
    caption: null,
    text: null,
    background: null,
    media: { url: `https://cdn/${id}.jpg`, posterUrl: null, width: 1, height: 1, durationMs: null } as never,
    sticker: null,
    call: null,
    layers: [],
    altText: null,
    publishedAt: null,
    expiresAt: null,
    audiences: [],
    viewer: {} as never,
    own: null,
    ...extra,
  } as Story;
}

beforeEach(() => {
  resetPreloadForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("assetsOfStory", () => {
  it("a photo: the picture, then every photo layer and the drawing, then the avatar", () => {
    const assets = assetsOfStory(
      story("p", {
        layers: [
          { type: "text", id: "t" } as never,
          { type: "image", id: "i", url: "https://cdn/layer.jpg" } as never,
          { type: "drawing", id: "d", url: "https://cdn/draw.png" } as never,
        ],
      }),
      { video: true },
    );
    expect(assets.map((asset) => asset.url)).toEqual([
      "https://cdn/p.jpg",
      "https://cdn/layer.jpg",
      "https://cdn/draw.png",
      "https://cdn/avatar-p.png",
    ]);
    expect(assets.every((asset) => asset.kind === "image")).toBe(true);
  });

  it("a video: the poster first and the clip last, and no clip when saving data", () => {
    const clip = story("v", {
      kind: "video",
      media: { url: "https://cdn/v.mp4", posterUrl: "https://cdn/v.jpg", width: 1, height: 1, durationMs: 5000 } as never,
    });
    expect(assetsOfStory(clip, { video: true }).map((asset) => asset.url)).toEqual([
      "https://cdn/v.jpg",
      "https://cdn/avatar-v.png",
      "https://cdn/v.mp4",
    ]);
    expect(assetsOfStory(clip, { video: false }).map((asset) => asset.kind)).toEqual(["image", "image"]);
  });

  it("a text card has only its author", () => {
    expect(assetsOfStory(story("t", { kind: "text", media: null }), { video: true }).map((asset) => asset.url)).toEqual([
      "https://cdn/avatar-t.png",
    ]);
  });
});

describe("StoryPreloader", () => {
  it("never has more than two downloads going, and starts the next one as each finishes", () => {
    const { preloader, images } = harness();
    preloader.setSource("viewer", 0, [img("a"), img("b"), img("c"), img("d")]);
    expect(MAX_CONCURRENT).toBe(2);
    expect(images.map((image) => image.src)).toEqual(["a", "b"]);
    images[0]!.finish();
    return flush().then(() => {
      expect(images.map((image) => image.src)).toEqual(["a", "b", "c"]);
      expect(preloader.isReady("image:a")).toBe(true);
      expect(preloader.activeKeys()).toEqual(["image:b", "image:c"]);
    });
  });

  it("decodes a picture before calling it ready", async () => {
    const { preloader, images } = harness();
    preloader.setSource("viewer", 0, [img("a")]);
    expect(preloader.isReady("image:a")).toBe(false);
    images[0]!.finish();
    await flush();
    expect(images[0]!.decode).toHaveBeenCalled();
    expect(preloader.isReady("image:a")).toBe(true);
  });

  it("cancels what leaves the window and aborts the download", () => {
    const { preloader, images } = harness();
    preloader.setSource("viewer", 0, [img("a"), img("b")]);
    preloader.setSource("viewer", 0, [img("b"), img("c")]);
    // `a` was still downloading and nobody wants it: its request is aborted.
    expect(images[0]!.src).toBe("");
    expect(preloader.activeKeys()).toEqual(["image:b", "image:c"]);
    expect(preloader.stats.cancelled).toBe(1);
  });

  it("closing a source cancels everything it was waiting for", () => {
    const { preloader, images } = harness();
    preloader.setSource("viewer", 0, [img("a"), img("b")]);
    preloader.clearSource("viewer");
    expect(images.every((image) => image.src === "")).toBe(true);
    expect(preloader.activeKeys()).toEqual([]);
  });

  it("the viewer goes before a strip, and one asset wanted twice is fetched once", () => {
    const { preloader, images } = harness();
    preloader.setSource("strip:qg", 10, [img("t1"), img("shared"), img("t3")]);
    preloader.setSource("viewer", 0, [img("v1"), img("shared")]);
    expect(images.map((image) => image.src).filter(Boolean)).toEqual(expect.arrayContaining(["v1"]));
    // The two slots went to the viewer's list first: v1 and shared.
    expect(preloader.activeKeys().sort()).toEqual(["image:shared", "image:v1"]);
  });

  it("a clip is buffered on a hidden muted element and ready once the browser has what it wants", () => {
    const { preloader, videos } = harness();
    preloader.setSource("viewer", 0, [vid("clip")]);
    const video = videos[0]!;
    expect(video).toMatchObject({ preload: "auto", muted: true, playsInline: true, src: "clip" });
    expect(video.load).toHaveBeenCalled();
    // Nothing decodable yet: `suspend` alone is not ready.
    video.emit("suspend");
    expect(preloader.isReady("video:clip")).toBe(false);
    video.readyState = 3;
    video.emit("suspend");
    expect(preloader.isReady("video:clip")).toBe(true);
  });

  it("hands a buffered clip over to the viewer, once", () => {
    const { preloader, videos } = harness();
    preloader.setSource("viewer", 0, [vid("clip")]);
    videos[0]!.readyState = 4;
    videos[0]!.emit("canplaythrough");
    expect(preloader.takeVideo("clip")).toBe(videos[0]);
    expect(preloader.takeVideo("clip")).toBeNull();
    expect(preloader.isReady("video:clip")).toBe(false);
  });

  it("skips video while the browser says the person is saving data, and still warms pictures", () => {
    const { preloader, images, videos } = harness(true);
    preloader.setSource("viewer", 0, [vid("clip"), img("a")]);
    expect(videos).toHaveLength(0);
    expect(images.map((image) => image.src)).toEqual(["a"]);
  });

  it("a download that never finishes gives its slot away", () => {
    vi.useFakeTimers();
    const { preloader, images } = harness();
    preloader.setSource("viewer", 0, [img("slow1"), img("slow2"), img("next")]);
    expect(images.map((image) => image.src)).toEqual(["slow1", "slow2"]);
    vi.advanceTimersByTime(21_000);
    expect(images.map((image) => image.src)).toContain("next");
  });

  it("keeps no more finished pictures than its cap, even when every one is still wanted", async () => {
    const { preloader, images } = harness();
    const many = Array.from({ length: 70 }, (_, index) => img(`p${index}`));
    preloader.setSource("viewer", 0, many);
    for (let round = 0; round < 70; round += 1) {
      const running = images.filter((image) => image.src !== "" && image.onload);
      for (const image of running) {
        image.finish();
      }
      await flush();
    }
    const kept = many.filter((asset) => preloader.isReady(asset.key)).length;
    expect(kept).toBeLessThanOrEqual(48);
  });

  it("a failed asset is not tried again and does not block the rest", async () => {
    const { preloader, images } = harness();
    preloader.setSource("viewer", 0, [img("bad"), img("ok")]);
    images[0]!.onerror?.();
    await flush();
    preloader.setSource("viewer", 0, [img("bad"), img("ok")]);
    expect(images.filter((image) => image.src === "bad" || image.src === "")).toHaveLength(1);
    expect(preloader.activeKeys()).toEqual(["image:ok"]);
  });
});

describe("rememberStories", () => {
  it("gives a story read for warming back for a few minutes, so its presigned URLs are the ones warmed", () => {
    const s = story("m1");
    rememberStories([s]);
    expect(rememberedStory("m1")).toBe(s);
    expect(rememberedStory("m1", Date.now() + REMEMBER_STORIES_MS - 1000)).toBe(s);
    expect(rememberedStory("m1", Date.now() + REMEMBER_STORIES_MS + 1000)).toBeNull();
    expect(rememberedStory("unknown")).toBeNull();
  });
});

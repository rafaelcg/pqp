import { describe, expect, it } from "vitest";
import {
  MOBILE_RENDITION_MAX_WIDTH,
  communityHomeVideoUrl,
  prefersMobileRendition,
} from "./rendition";

const video = {
  kind: "video" as const,
  url: "https://s.example/landscape.mp4",
  mobile: {
    name: "vertical.mp4",
    contentType: "video/mp4",
    byteSize: 10,
    url: "https://s.example/vertical.mp4",
  },
};

describe("prefersMobileRendition", () => {
  it.each([
    ["iPhone portrait", { width: 390, height: 844, coarsePointer: true }, true],
    ["Android portrait", { width: 412, height: 915, coarsePointer: true }, true],
    ["iPhone landscape", { width: 844, height: 390, coarsePointer: true }, false],
    ["iPad portrait", { width: 820, height: 1180, coarsePointer: true }, true],
    ["iPad landscape", { width: 1180, height: 820, coarsePointer: true }, false],
    ["desktop", { width: 1440, height: 900, coarsePointer: false }, false],
    ["tall desktop window, mouse", { width: 900, height: 1300, coarsePointer: false }, false],
    ["narrow desktop window", { width: 600, height: 900, coarsePointer: false }, true],
    ["exactly at the cut-off", { width: MOBILE_RENDITION_MAX_WIDTH, height: 400, coarsePointer: false }, true],
    ["one past the cut-off", { width: MOBILE_RENDITION_MAX_WIDTH + 1, height: 400, coarsePointer: false }, false],
    ["no layout yet", { width: 0, height: 0, coarsePointer: true }, false],
  ])("%s", (_label, viewport, expected) => {
    expect(prefersMobileRendition(viewport)).toBe(expected);
  });
});

describe("communityHomeVideoUrl", () => {
  const phone = { width: 390, height: 844, coarsePointer: true };
  const desktop = { width: 1440, height: 900, coarsePointer: false };

  it("plays the vertical cut on a phone and the main one elsewhere", () => {
    expect(communityHomeVideoUrl(video, phone)).toEqual({
      url: "https://s.example/vertical.mp4",
      rendition: "mobile",
    });
    expect(communityHomeVideoUrl(video, desktop)).toEqual({
      url: "https://s.example/landscape.mp4",
      rendition: "main",
    });
  });

  it("falls back to the main video when there is no cut, or it has no URL", () => {
    expect(communityHomeVideoUrl({ ...video, mobile: null }, phone).rendition).toBe("main");
    expect(communityHomeVideoUrl({ ...video, mobile: undefined }, phone).rendition).toBe("main");
    expect(
      communityHomeVideoUrl({ ...video, mobile: { ...video.mobile, url: null } }, phone),
    ).toEqual({ url: "https://s.example/landscape.mp4", rendition: "main" });
  });

  it("never picks a cut for anything that is not a video", () => {
    expect(
      communityHomeVideoUrl({ ...video, kind: "image", url: "https://s.example/x.png" }, phone),
    ).toEqual({ url: "https://s.example/x.png", rendition: "main" });
  });
});

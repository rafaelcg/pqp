// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureCoverFrame,
  COMMUNITY_HOME_COVER_MAX_BYTES,
  CoverFrameError,
  coverForCreate,
  coverForPreview,
  coverForUpdate,
  coverFrameSize,
  coverImageProblem,
  type CoverDraft,
} from "./cover";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coverImageProblem", () => {
  it("takes a real JPEG or PNG", async () => {
    expect(await coverImageProblem(new File([JPEG], "capa.jpg", { type: "image/jpeg" }))).toBeNull();
    expect(await coverImageProblem(new File([PNG], "capa.png", { type: "image/png" }))).toBeNull();
  });

  it("refuses a GIF, a video, and a text file named like a picture", async () => {
    expect(await coverImageProblem(new File([GIF], "a.gif", { type: "image/gif" }))).toBe("type");
    expect(await coverImageProblem(new File(["x"], "a.mp4", { type: "video/mp4" }))).toBe("type");
    expect(await coverImageProblem(new File(["not a png"], "a.png", { type: "image/png" }))).toBe(
      "type",
    );
    // A GIF wearing a JPEG name is judged by its bytes.
    expect(await coverImageProblem(new File([GIF], "a.jpg", { type: "image/jpeg" }))).toBe("type");
  });

  it("refuses a picture over the cover limit before anything is read", async () => {
    const big = new File([JPEG], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(big, "size", { value: COMMUNITY_HOME_COVER_MAX_BYTES + 1 });
    expect(await coverImageProblem(big)).toBe("size");
  });
});

describe("coverFrameSize", () => {
  it("keeps a frame at its own size up to the cap, and scales the long side down past it", () => {
    expect(coverFrameSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(coverFrameSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(coverFrameSize(1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(coverFrameSize(2160, 3840)).toEqual({ width: 1080, height: 1920 });
  });

  it("has nothing to draw before the video knows its size", () => {
    expect(coverFrameSize(0, 0)).toBeNull();
    expect(coverFrameSize(Number.NaN, 720)).toBeNull();
  });
});

describe("the composer's cover draft", () => {
  const base: CoverDraft = {
    mainIsVideo: true,
    upload: null,
    previewUrl: null,
    existing: null,
    cleared: false,
  };

  it("no pick and no cover on the post: the first frame, and nothing is sent", () => {
    expect(coverForPreview(base)).toBeNull();
    expect(coverForCreate(base)).toEqual({});
    expect(coverForUpdate(base)).toEqual({});
  });

  it("a pick shows in the preview and is sent on create and on edit", () => {
    const picked = { ...base, upload: { uploadId: "u-1" }, previewUrl: "blob:capa" };
    expect(coverForPreview(picked)).toBe("blob:capa");
    expect(coverForCreate(picked)).toEqual({ posterUploadId: "u-1" });
    expect(coverForUpdate(picked)).toEqual({ posterUploadId: "u-1" });
  });

  it("editing keeps the post's cover by saying nothing, and going back to the first frame sends null", () => {
    const onPost = { ...base, existing: "https://bucket/capa.jpg" };
    expect(coverForPreview(onPost)).toBe("https://bucket/capa.jpg");
    expect(coverForUpdate(onPost)).toEqual({});
    const reset = { ...onPost, cleared: true };
    expect(coverForPreview(reset)).toBeNull();
    expect(coverForUpdate(reset)).toEqual({ posterUploadId: null });
  });

  it("a pick never rides along once the main media is not a video", () => {
    const stale = {
      ...base,
      mainIsVideo: false,
      upload: { uploadId: "u-1" },
      previewUrl: "blob:capa",
    };
    expect(coverForPreview(stale)).toBeNull();
    expect(coverForCreate(stale)).toEqual({});
    expect(coverForUpdate(stale)).toEqual({});
  });
});

describe("captureCoverFrame", () => {
  function fakeVideo(width: number, height: number): HTMLVideoElement {
    const video = document.createElement("video");
    Object.defineProperty(video, "videoWidth", { value: width });
    Object.defineProperty(video, "videoHeight", { value: height });
    return video;
  }

  it("draws the frame on screen at its size and hands back a JPEG", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback) {
        done(new Blob([JPEG], { type: "image/jpeg" }));
      });
    const video = fakeVideo(3840, 2160);
    const file = await captureCoverFrame(video);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", expect.any(Number));
    expect(file.name).toBe("capa.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(JPEG.length);
  });

  it("says so when the browser will not read a video from another origin", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {
      throw new DOMException("The canvas has been tainted", "SecurityError");
    });
    const error = await captureCoverFrame(fakeVideo(1280, 720)).catch((caught) => caught);
    expect(error).toBeInstanceOf(CoverFrameError);
    expect((error as CoverFrameError).reason).toBe("tainted");
  });

  it("refuses before the video has a frame", async () => {
    const error = await captureCoverFrame(fakeVideo(0, 0)).catch((caught) => caught);
    expect((error as CoverFrameError).reason).toBe("no-frame");
  });
});

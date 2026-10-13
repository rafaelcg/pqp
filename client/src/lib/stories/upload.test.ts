import { describe, expect, it, vi } from "vitest";
import { STORY_MAX_BYTES } from "@pqp/shared";
import {
  checkStoryFile,
  checkVideoDuration,
  fitWithin,
  prepareRecordedClip,
  putStoryMedia,
} from "./upload";

describe("checkStoryFile", () => {
  it("refuses what the bytes say is not an allowed type", () => {
    expect(checkStoryFile(null, 10)).toEqual({ kind: "wrong-type" });
  });

  it("refuses video where video is off (no frames can be scanned)", () => {
    expect(checkStoryFile("video/mp4", 10, { videoEnabled: false })).toEqual({ kind: "wrong-type" });
    expect(checkStoryFile("image/png", 10, { videoEnabled: false })).toBeNull();
  });

  it("a video over the cap is refused before upload", () => {
    expect(checkStoryFile("video/mp4", STORY_MAX_BYTES + 1)).toEqual({ kind: "too-big" });
    expect(checkStoryFile("video/mp4", STORY_MAX_BYTES)).toBeNull();
  });

  it("an image may start bigger, because it is re-encoded smaller first", () => {
    expect(checkStoryFile("image/jpeg", STORY_MAX_BYTES * 2)).toBeNull();
    expect(checkStoryFile("image/jpeg", STORY_MAX_BYTES * 5)).toEqual({ kind: "too-big" });
  });
});

describe("checkVideoDuration", () => {
  it("says the length in seconds when it is over 30 s", () => {
    expect(checkVideoDuration(31_200)).toEqual({ kind: "too-long", seconds: 31 });
    expect(checkVideoDuration(30_000)).toBeNull();
  });

  it("an unreadable length is refused, not let through", () => {
    expect(checkVideoDuration(Number.NaN)).toEqual({ kind: "unreadable" });
    expect(checkVideoDuration(0)).toEqual({ kind: "unreadable" });
  });
});

describe("fitWithin", () => {
  it("caps the long side at 1440 and keeps the aspect", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1440, height: 1080 });
    expect(fitWithin(1080, 1920)).toEqual({ width: 810, height: 1440 });
  });

  it("never upscales", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("putStoryMedia", () => {
  it("sends exactly the signed headers, minus the ones a browser sets itself", async () => {
    const set: [string, string][] = [];
    class FakeXhr {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      status = 200;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open = vi.fn();
      setRequestHeader(name: string, value: string) {
        set.push([name, value]);
      }
      send() {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
        this.onload?.();
      }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    await putStoryMedia(
      {
        url: "https://bucket/x",
        method: "PUT",
        headers: { "Content-Type": "image/jpeg", "Content-Length": "10", "x-amz-meta-a": "b" },
        expiresAt: "",
      },
      new Blob(["0123456789"]),
      (fraction) => progress.push(fraction),
    );
    expect(set).toEqual([
      ["Content-Type", "image/jpeg"],
      ["x-amz-meta-a", "b"],
    ]);
    expect(progress).toEqual([0.5, 1]);
    vi.unstubAllGlobals();
  });
});

describe("prepareRecordedClip", () => {
  const limits = { maxBytes: 1000, maxVideoMs: 30_000, videoEnabled: true };
  // "ftyp" box with the "isom" brand: what a MediaRecorder writes for MP4.
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);

  it("refuses a recording that is not an MP4 on the bytes (a WebM from a browser that ignored the type)", async () => {
    const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])], { type: "video/webm" });
    expect(await prepareRecordedClip({ blob: webm, durationMs: 5000 }, limits, null)).toEqual({
      ok: false,
      problem: { kind: "wrong-type" },
    });
  });

  it("refuses a recording over the byte cap before probing anything", async () => {
    const big = new Blob([mp4, new Uint8Array(2000)], { type: "video/mp4;codecs=avc1" });
    expect(await prepareRecordedClip({ blob: big, durationMs: 5000 }, limits, null)).toEqual({
      ok: false,
      problem: { kind: "too-big" },
    });
  });

  it("refuses video where the deployment has none", async () => {
    const clip = new Blob([mp4], { type: "video/mp4" });
    const result = await prepareRecordedClip({ blob: clip, durationMs: 5000 }, { ...limits, videoEnabled: false }, null);
    expect(result).toEqual({ ok: false, problem: { kind: "wrong-type" } });
  });
});

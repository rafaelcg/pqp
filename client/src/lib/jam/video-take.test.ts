import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVideoRecording, VIDEO_MIME_PREFERENCE } from "./video-take";

/**
 * `startVideoRecording` against a stand-in MediaRecorder: which type it ends
 * up recording, and that a recorder that fails as it starts (Chromium's MP4
 * does: `Internal Error` in the same tick as `start`) costs the take nothing
 * but the next type. The alignment maths is in `misc.test.ts`.
 */

type Behaviour = "ok" | "error" | "inactive" | "throws";

const behaviour = new Map<string, Behaviour>();
const started: string[] = [];

class FakeRecorder {
  static isTypeSupported(type: string): boolean {
    return behaviour.has(type);
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstart: (() => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: { error: Error }) => void) | null = null;
  constructor(_stream: unknown, options: { mimeType?: string }) {
    this.mimeType = options.mimeType ?? "";
    if (behaviour.get(this.mimeType) === "throws") throw new Error("NotSupportedError");
  }
  start() {
    started.push(this.mimeType);
    const how = behaviour.get(this.mimeType);
    this.state = "recording";
    queueMicrotask(() => {
      this.onstart?.();
      if (how === "error") {
        this.state = "inactive";
        this.onerror?.({ error: new Error("Internal Error.") });
      } else if (how === "inactive") {
        this.state = "inactive";
      }
    });
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["bytes"]) });
    this.onstop?.();
  }
}

class FakeStream {
  constructor(public tracks: unknown[]) {}
}

const context = { currentTime: 1.5 } as unknown as AudioContext;
const camera = { getVideoTracks: () => [{}] } as unknown as MediaStream;
const mic = {} as MediaStreamTrack;

async function start(options: { mimeType?: string } = {}) {
  const pending = startVideoRecording(context, camera, mic, options);
  await vi.advanceTimersByTimeAsync(1000);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  behaviour.clear();
  started.length = 0;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("MediaStream", FakeStream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startVideoRecording", () => {
  it("records the first supported type of the preference order", async () => {
    for (const type of VIDEO_MIME_PREFERENCE) behaviour.set(type, "ok");
    const recording = await start();
    expect(recording.mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(started).toEqual(["video/webm;codecs=vp9,opus"]);
    expect(recording.startedAtCtx).toBe(1.5);
    expect((await recording.stop()).size).toBe(5);
  });

  it("is the MP4 where that is all the browser records (Safari)", async () => {
    behaviour.set("video/mp4;codecs=avc1.42E01E,mp4a.40.2", "ok");
    behaviour.set("video/mp4", "ok");
    expect((await start()).mimeType).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
  });

  it("drops a recorder that errors as it starts for the next supported type", async () => {
    behaviour.set("video/mp4;codecs=avc1.42E01E,mp4a.40.2", "error");
    behaviour.set("video/mp4", "ok");
    const recording = await start();
    expect(started).toEqual(["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"]);
    expect(recording.mimeType).toBe("video/mp4");
  });

  it("drops one that goes inactive without saying why, and one the constructor refuses", async () => {
    behaviour.set("video/webm;codecs=vp9,opus", "inactive");
    behaviour.set("video/webm;codecs=vp8,opus", "throws");
    behaviour.set("video/webm", "ok");
    expect((await start()).mimeType).toBe("video/webm");
    expect(started).toEqual(["video/webm;codecs=vp9,opus", "video/webm"]);
  });

  it("fails with the last reason when nothing records, so the studio can say the camera could not start", async () => {
    behaviour.set("video/webm", "error");
    behaviour.set("video/mp4", "inactive");
    const result = startVideoRecording(context, camera, mic);
    const settled = result.then(
      () => "recorded",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await settled).toMatch(/stopped as it started/);
  });

  it("a forced type is the only one tried", async () => {
    behaviour.set("video/mp4", "error");
    behaviour.set("video/webm", "ok");
    const result = startVideoRecording(context, camera, mic, { mimeType: "video/mp4" });
    const settled = result.then(
      () => "recorded",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await settled).toMatch(/Internal Error/);
    expect(started).toEqual(["video/mp4"]);
  });

  it("with nothing on the list supported, takes the browser's own default", async () => {
    behaviour.set("", "ok");
    const recording = await start();
    expect(started).toEqual([""]);
    expect(recording.mimeType).toBe("");
  });
});

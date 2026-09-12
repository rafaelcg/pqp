import { describe, expect, it, vi } from "vitest";
import {
  applyScreenFrameLock,
  lockScreenStreamToFps,
  mediaStreamSize,
  publishLockSize,
  shouldLockScreenFrameRate,
  tryPinDisplayFrameRate,
  type ScreenFrameLockDom,
  type ScreenLockCanvas,
  type ScreenLockVideo,
} from "./screen-frame-lock";

class FakeTrack {
  kind: "audio" | "video";
  id: string;
  readyState: MediaStreamTrackState = "live";
  contentHint = "";
  stopped = false;
  applied: MediaTrackConstraints[] = [];
  private listeners = new Map<string, Set<() => void>>();
  constructor(
    kind: "audio" | "video",
    id: string,
    readonly settings: MediaTrackSettings = {},
  ) {
    this.kind = kind;
    this.id = id;
  }
  getSettings() {
    return { ...this.settings };
  }
  async applyConstraints(constraints: MediaTrackConstraints) {
    this.applied.push(constraints);
  }
  addEventListener(type: string, fn: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.readyState = "ended";
    for (const fn of this.listeners.get("ended") ?? []) {
      fn();
    }
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = [...tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getTracks() {
    return this.tracks;
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: FakeTrack) {
    this.tracks = this.tracks.filter((held) => held !== track);
  }
}

function fakeDom(
  locked: FakeTrack,
  capturedFps: number[],
  videoSize: { width: number; height: number } = { width: 1280, height: 720 },
): { dom: ScreenFrameLockDom; canvas: ScreenLockCanvas } {
  const canvas: ScreenLockCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    captureStream: (fps: number) => {
      capturedFps.push(fps);
      return { getVideoTracks: () => [locked as unknown as MediaStreamTrack] };
    },
  };
  const video: ScreenLockVideo = {
    muted: false,
    playsInline: false,
    srcObject: null,
    videoWidth: videoSize.width,
    videoHeight: videoSize.height,
    readyState: 2,
    play: async () => {},
    pause: () => {},
  };
  return {
    canvas,
    dom: {
      createElement: (tag) => (tag === "canvas" ? canvas : video),
    },
  };
}

describe("shouldLockScreenFrameRate", () => {
  it("locks only the 30 fps ask (auto-follows a 30 ladder, or a 30 pin)", () => {
    expect(shouldLockScreenFrameRate(30)).toBe(true);
    expect(shouldLockScreenFrameRate(60)).toBe(false);
    expect(shouldLockScreenFrameRate(undefined)).toBe(false);
  });
});

describe("tryPinDisplayFrameRate", () => {
  it("asks min/ideal/max and swallows OverconstrainedError", async () => {
    const ok = new FakeTrack("video", "ok");
    expect(await tryPinDisplayFrameRate(ok, 30)).toBe(true);
    expect(ok.applied).toEqual([{ frameRate: { min: 30, ideal: 30, max: 30 } }]);

    const stubborn = {
      applyConstraints: async () => {
        throw Object.assign(new Error("over"), { name: "OverconstrainedError" });
      },
    };
    expect(await tryPinDisplayFrameRate(stubborn, 30)).toBe(false);
  });
});

describe("mediaStreamSize", () => {
  it("prefers decoded videoWidth over track settings (MediaStream, not CSS)", () => {
    expect(
      mediaStreamSize(
        { videoWidth: 1920, videoHeight: 1080 },
        { width: 1114, height: 626 },
      ),
    ).toEqual({ width: 1920, height: 1080 });
  });

  it("falls back to track getSettings when the video has no frame yet", () => {
    expect(
      mediaStreamSize({ videoWidth: 0, videoHeight: 0 }, { width: 1280, height: 720 }),
    ).toEqual({ width: 1280, height: 720 });
  });
});

describe("publishLockSize", () => {
  it("scales a tab CSS box (1114x626) up to 1280x720", () => {
    expect(publishLockSize(1114, 626)).toEqual({ width: 1280, height: 720 });
  });

  it("keeps a real 1280x720 or 1920x1080 capture", () => {
    expect(publishLockSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(publishLockSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("lockScreenStreamToFps", () => {
  it("keeps audio and clocks the published video at 30", async () => {
    const capturedFps: number[] = [];
    const locked = new FakeTrack("video", "locked", { frameRate: 0 });
    const source = new FakeTrack("video", "source", {
      frameRate: 24,
      width: 1280,
      height: 720,
      displaySurface: "browser",
    });
    const audio = new FakeTrack("audio", "tab-audio");
    const stream = new FakeStream([source, audio]);
    const { dom, canvas } = fakeDom(locked, capturedFps);

    const lock = await lockScreenStreamToFps(
      stream as unknown as MediaStream,
      30,
      dom,
    );

    expect(lock).not.toBeNull();
    expect(capturedFps).toEqual([30]);
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(stream.getVideoTracks()).toEqual([locked]);
    expect(stream.getAudioTracks()).toEqual([audio]);
    expect(locked.getSettings().frameRate).toBe(30);
    expect(locked.getSettings().displaySurface).toBe("browser");
    expect(locked.getSettings().width).toBe(1280);
    expect(locked.getSettings().height).toBe(720);
    expect(locked.contentHint).toBe("motion");
    lock?.stop();
  });

  it("does not publish a 1114x626 preview box", async () => {
    const locked = new FakeTrack("video", "locked");
    const source = new FakeTrack("video", "source", {
      width: 1114,
      height: 626,
    });
    const stream = new FakeStream([source]);
    const { dom, canvas } = fakeDom(locked, [], { width: 1114, height: 626 });

    const lock = await lockScreenStreamToFps(
      stream as unknown as MediaStream,
      30,
      dom,
    );

    expect(lock).not.toBeNull();
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(locked.getSettings().width).toBe(1280);
    expect(locked.getSettings().height).toBe(720);
    lock?.stop();
  });

  it("forwards applyConstraints to the raw capture, not the canvas track", async () => {
    const locked = new FakeTrack("video", "locked");
    const source = new FakeTrack("video", "source", { frameRate: 22, height: 720 });
    const stream = new FakeStream([source]);
    const { dom } = fakeDom(locked, []);
    const lock = await lockScreenStreamToFps(
      stream as unknown as MediaStream,
      30,
      dom,
    );
    expect(lock).not.toBeNull();

    await locked.applyConstraints({ height: { max: 720 } });
    expect(source.applied).toEqual([{ height: { max: 720 } }]);
    lock?.stop();
  });

  it("stops the locked track when the capture ends (Chrome Stop sharing)", async () => {
    const locked = new FakeTrack("video", "locked");
    const source = new FakeTrack("video", "source");
    const stream = new FakeStream([source]);
    await lockScreenStreamToFps(
      stream as unknown as MediaStream,
      30,
      fakeDom(locked, []).dom,
    );

    source.stop();
    expect(locked.stopped).toBe(true);
  });

  it("leaves the stream alone when this engine cannot captureStream", async () => {
    const source = new FakeTrack("video", "source");
    const audio = new FakeTrack("audio", "tab-audio");
    const stream = new FakeStream([source, audio]);
    const lock = await lockScreenStreamToFps(stream as unknown as MediaStream, 30, {
      createElement: () =>
        ({
          width: 0,
          height: 0,
          getContext: () => null,
          captureStream: undefined,
        }) as unknown as ScreenLockCanvas,
    });
    expect(lock).toBeNull();
    expect(stream.getVideoTracks()).toEqual([source]);
    expect(stream.getAudioTracks()).toEqual([audio]);
  });
});

describe("applyScreenFrameLock", () => {
  it("does nothing for a 60 fps gaming share", async () => {
    const source = new FakeTrack("video", "game");
    const stream = new FakeStream([source]);
    const lock = await applyScreenFrameLock(
      stream as unknown as MediaStream,
      60,
      fakeDom(new FakeTrack("video", "locked"), []).dom,
    );
    expect(lock).toBeNull();
    expect(stream.getVideoTracks()).toEqual([source]);
  });

  it("locks when auto-follows-ladder asked for 30", async () => {
    const capturedFps: number[] = [];
    const locked = new FakeTrack("video", "locked");
    const source = new FakeTrack("video", "film", { frameRate: 27 });
    const stream = new FakeStream([source]);
    const lock = await applyScreenFrameLock(
      stream as unknown as MediaStream,
      30,
      fakeDom(locked, capturedFps).dom,
    );
    expect(lock).not.toBeNull();
    expect(capturedFps).toEqual([30]);
    expect(stream.getVideoTracks()).toEqual([locked]);
    lock?.stop();
  });
});

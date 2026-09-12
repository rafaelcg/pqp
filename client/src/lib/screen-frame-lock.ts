/**
 * Lock a published screen track to a 30 Hz grid.
 *
 * Chrome tab capture of a 24 fps YouTube tab paints ~24/s. getDisplayMedia
 * `frameRate: { ideal: 30, max: 30 }` is a hint; `applyConstraints` on
 * display media is ignored; `min: 30` Overconstrains a 24 fps tab and
 * kills the share. canvas.captureStream(30) is the clock: draw whenever
 * the source paints, sample-and-hold at 30 Hz (3:2).
 *
 * Only when the caller asked for 30 (auto-follows a 30-only ladder, or
 * the presenter pinned 30). A 60 fps gaming share is left alone.
 */

export function shouldLockScreenFrameRate(
  maxFrameRate: 30 | 60 | undefined,
): boolean {
  return maxFrameRate === 30;
}

export interface ScreenFrameLock {
  /** Published video: canvas.captureStream at the locked fps. */
  track: MediaStreamTrack;
  /** Raw getDisplayMedia video. Keep running; stop with the lock. */
  source: MediaStreamTrack;
  stop(): void;
}

/** Narrow DOM bits the lock needs, so a Node test can stand in. */
export interface ScreenFrameLockDom {
  createElement(tag: "canvas" | "video"): ScreenLockCanvas | ScreenLockVideo;
}

export interface ScreenLockCanvas {
  width: number;
  height: number;
  getContext(
    id: "2d",
    opts?: { alpha?: boolean; desynchronized?: boolean },
  ): ScreenLockCanvasContext | null;
  captureStream(fps: number): { getVideoTracks(): MediaStreamTrack[] };
}

export interface ScreenLockCanvasContext {
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
}

export interface ScreenLockVideo {
  muted: boolean;
  playsInline: boolean;
  srcObject: MediaStream | null;
  videoWidth: number;
  videoHeight: number;
  readyState: number;
  play(): Promise<void>;
  pause(): void;
  requestVideoFrameCallback?: (callback: () => void) => number;
}

function browserDom(): ScreenFrameLockDom | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return null;
  }
  return {
    createElement: (tag) =>
      document.createElement(tag) as unknown as ScreenLockCanvas | ScreenLockVideo,
  };
}

function playbackStream(source: MediaStreamTrack): MediaStream {
  if (typeof MediaStream === "function") {
    return new MediaStream([source]);
  }
  return {
    getVideoTracks: () => [source],
    getTracks: () => [source],
  } as MediaStream;
}

/**
 * Sample-and-hold `source` onto a locked `fps` Hz grid.
 *
 * Returns null when this engine cannot (no canvas.captureStream). The
 * share then goes out as Chrome delivered it; do not fail the picker.
 */
export function lockScreenVideoToFps(
  source: MediaStreamTrack,
  fps: 30,
  dom: ScreenFrameLockDom | null = browserDom(),
): ScreenFrameLock | null {
  if (!dom) {
    return null;
  }
  let canvas: ScreenLockCanvas;
  let video: ScreenLockVideo;
  try {
    canvas = dom.createElement("canvas") as ScreenLockCanvas;
    video = dom.createElement("video") as ScreenLockVideo;
  } catch {
    return null;
  }
  if (typeof canvas.captureStream !== "function" || typeof canvas.getContext !== "function") {
    return null;
  }
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) {
    return null;
  }

  const sourceSettings = (): MediaTrackSettings => {
    try {
      return typeof source.getSettings === "function" ? source.getSettings() : {};
    } catch {
      return {};
    }
  };

  const syncSize = () => {
    const settings = sourceSettings();
    const width =
      video.videoWidth ||
      (typeof settings.width === "number" && settings.width > 0 ? settings.width : 0) ||
      1280;
    const height =
      video.videoHeight ||
      (typeof settings.height === "number" && settings.height > 0 ? settings.height : 0) ||
      720;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };

  syncSize();

  const draw = () => {
    syncSize();
    if (video.readyState >= 2 && canvas.width > 0 && canvas.height > 0) {
      ctx.drawImage(video as unknown as CanvasImageSource, 0, 0);
    }
  };

  let running = true;
  const pump = () => {
    if (!running || source.readyState === "ended") {
      return;
    }
    draw();
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(pump);
    } else if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(pump);
    }
  };

  video.muted = true;
  video.playsInline = true;
  video.srcObject = playbackStream(source);
  void video.play().then(pump).catch(pump);

  let lockedStream: { getVideoTracks(): MediaStreamTrack[] };
  try {
    lockedStream = canvas.captureStream(fps);
  } catch {
    running = false;
    video.srcObject = null;
    return null;
  }
  const track = lockedStream.getVideoTracks()[0];
  if (!track) {
    running = false;
    video.srcObject = null;
    return null;
  }

  const nativeGetSettings =
    typeof track.getSettings === "function" ? track.getSettings.bind(track) : () => ({});
  track.getSettings = () => ({
    ...nativeGetSettings(),
    ...sourceSettings(),
    frameRate: fps,
  });

  const nativeApply =
    typeof track.applyConstraints === "function"
      ? track.applyConstraints.bind(track)
      : async () => {};
  track.applyConstraints = async (constraints) => {
    if (typeof source.applyConstraints === "function") {
      await source.applyConstraints(constraints);
    }
    try {
      await nativeApply(constraints);
    } catch {
      // Canvas tracks often refuse; the source is the one that can resize.
    }
  };

  try {
    track.contentHint = source.contentHint || "motion";
  } catch {
    // Read-only on older engines; share still publishes.
  }

  const onSourceEnded = () => {
    stop();
  };
  if (typeof source.addEventListener === "function") {
    source.addEventListener("ended", onSourceEnded);
  }

  function stop() {
    if (!running) {
      return;
    }
    running = false;
    if (typeof source.removeEventListener === "function") {
      source.removeEventListener("ended", onSourceEnded);
    }
    try {
      track.stop();
    } catch {
      // Already ended.
    }
    video.srcObject = null;
    try {
      video.pause();
    } catch {
      // Element already gone.
    }
  }

  return { track, source, stop };
}

/**
 * Swap the stream's video for a locked 30 Hz track. Audio is untouched.
 */
export function lockScreenStreamToFps(
  stream: MediaStream,
  fps: 30,
  dom: ScreenFrameLockDom | null = browserDom(),
): ScreenFrameLock | null {
  if (
    typeof stream.getVideoTracks !== "function" ||
    typeof stream.addTrack !== "function" ||
    typeof stream.removeTrack !== "function"
  ) {
    return null;
  }
  const source = stream.getVideoTracks()[0];
  if (!source) {
    return null;
  }
  const lock = lockScreenVideoToFps(source, fps, dom);
  if (!lock) {
    return null;
  }
  stream.removeTrack(source);
  stream.addTrack(lock.track);
  return lock;
}

export function applyScreenFrameLock(
  stream: MediaStream,
  maxFrameRate: 30 | 60 | undefined,
  dom: ScreenFrameLockDom | null = browserDom(),
): ScreenFrameLock | null {
  if (!shouldLockScreenFrameRate(maxFrameRate)) {
    return null;
  }
  return lockScreenStreamToFps(stream, 30, dom);
}

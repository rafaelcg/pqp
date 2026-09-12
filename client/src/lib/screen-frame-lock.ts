/**
 * Lock a published screen track to a 30 Hz grid.
 *
 * Chrome tab capture of a 24 fps YouTube tab paints ~24/s and the reported
 * `getSettings().frameRate` wanders 22–30. getDisplayMedia
 * `frameRate: { ideal: 30, max: 30 }` is a hint. `applyConstraints` with
 * `min: 30` is tried first and usually Overconstrains a 24 fps tab — that
 * must not kill the share. canvas.captureStream(30) plus a 30 Hz draw clock
 * is the pin: sample-and-hold (3:2) so Enviando holds ~30.
 *
 * Only when the caller asked for 30 (auto-follows a 30-only ladder, or
 * the presenter pinned 30). A 60 fps gaming share is left alone.
 * Audio tracks are never replaced.
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
 * Ask the raw capture for a hard 30 (or 60). Chrome display-media usually
 * ignores it or throws OverconstrainedError on a 24 fps tab. Never let that
 * fail the share — the canvas clock is the fallback.
 */
export async function tryPinDisplayFrameRate(
  track: { applyConstraints?: (c: MediaTrackConstraints) => Promise<void> },
  fps: 30 | 60,
): Promise<boolean> {
  if (typeof track.applyConstraints !== "function") {
    return false;
  }
  try {
    await track.applyConstraints({
      frameRate: { min: fps, ideal: fps, max: fps },
    });
    return true;
  } catch {
    return false;
  }
}

function startFrameClock(fps: 30, draw: () => void): () => void {
  const period = 1000 / fps;
  if (typeof requestAnimationFrame !== "function") {
    return () => {};
  }
  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();
  let next = now();
  let raf = 0;
  const tick = (t: number) => {
    if (t >= next) {
      draw();
      next += period;
      if (t - next > period) {
        next = t + period;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
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
    if (!running || source.readyState === "ended") {
      return;
    }
    syncSize();
    if (video.readyState >= 2 && canvas.width > 0 && canvas.height > 0) {
      ctx.drawImage(video as unknown as CanvasImageSource, 0, 0);
    }
  };

  let running = true;

  video.muted = true;
  video.playsInline = true;
  video.srcObject = playbackStream(source);
  void video.play().then(draw).catch(draw);

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

  const stopClock = startFrameClock(fps, draw);

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
    stopClock();
    if (typeof source.removeEventListener === "function") {
      source.removeEventListener("ended", onSourceEnded);
    }
    try {
      track.stop();
    } catch {
      // Already ended.
    }
    try {
      if (source.readyState !== "ended") {
        source.stop();
      }
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

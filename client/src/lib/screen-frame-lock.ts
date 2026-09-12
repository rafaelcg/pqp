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
 *
 * Size the canvas from the MediaStream (decoded `videoWidth` / track
 * `getSettings`), never from a preview tile's CSS box. A detached video
 * often never decodes — Chrome then reports the tab's CSS viewport
 * (e.g. 1114×626) and `captureStream` publishes a black frame. The
 * playback element is mounted off-screen and we wait for a real frame
 * before opening the capture. Sub-720 captures are scaled to 1280×720
 * so a 720p ladder is not fed a preview-sized box.
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
  drawImage(
    image: CanvasImageSource,
    dx: number,
    dy: number,
    dw?: number,
    dh?: number,
  ): void;
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

/** HLS 720p30 source. Do not publish a CSS-box capture under this. */
export const SCREEN_LOCK_MIN_WIDTH = 1280;
export const SCREEN_LOCK_MIN_HEIGHT = 720;

const FRAME_WAIT_MS = 400;

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

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/**
 * Intrinsic MediaStream size. `videoWidth` is the decoded frame (only
 * trustworthy after a frame). Track settings are next. Never `clientWidth`.
 */
export function mediaStreamSize(
  video: Pick<ScreenLockVideo, "videoWidth" | "videoHeight">,
  settings: Pick<MediaTrackSettings, "width" | "height">,
): { width: number; height: number } {
  const width =
    positiveInt(video.videoWidth) ||
    positiveInt(settings.width) ||
    SCREEN_LOCK_MIN_WIDTH;
  const height =
    positiveInt(video.videoHeight) ||
    positiveInt(settings.height) ||
    SCREEN_LOCK_MIN_HEIGHT;
  return { width, height };
}

/**
 * Publish at the MediaStream size, but never a sub-720 CSS box.
 * 1114×626 (a YouTube tab's viewport) becomes 1280×720; 1920×1080 stays.
 */
export function publishLockSize(
  width: number,
  height: number,
): { width: number; height: number } {
  if (width >= SCREEN_LOCK_MIN_WIDTH || height >= SCREEN_LOCK_MIN_HEIGHT) {
    return { width, height };
  }
  return { width: SCREEN_LOCK_MIN_WIDTH, height: SCREEN_LOCK_MIN_HEIGHT };
}

function mountHiddenVideo(video: ScreenLockVideo): () => void {
  const el = video as unknown as HTMLVideoElement;
  if (typeof document === "undefined" || !document.body || !el.style) {
    return () => {};
  }
  el.muted = true;
  el.defaultMuted = true;
  el.playsInline = true;
  el.autoplay = true;
  el.setAttribute("playsinline", "");
  el.setAttribute("muted", "");
  el.setAttribute("autoplay", "");
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    left: "-10000px",
    top: "0px",
    width: "64px",
    height: "36px",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(el);
  return () => {
    try {
      el.remove();
    } catch {
      // Already detached.
    }
  };
}

function waitForVideoFrame(video: ScreenLockVideo): Promise<void> {
  if (video.videoWidth > 0 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const el = video as unknown as HTMLVideoElement;
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (typeof el.removeEventListener === "function") {
        el.removeEventListener("loadedmetadata", done);
        el.removeEventListener("loadeddata", done);
      }
      resolve();
    };
    const timer = setTimeout(done, FRAME_WAIT_MS);
    if (typeof el.addEventListener === "function") {
      el.addEventListener("loadedmetadata", done);
      el.addEventListener("loadeddata", done);
    }
    const rvfc = (
      el as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }
    ).requestVideoFrameCallback;
    if (typeof rvfc === "function") {
      rvfc.call(el, done);
    }
    void video.play().then(() => {
      if (video.videoWidth > 0) {
        done();
      }
    }).catch(done);
  });
}

/**
 * Sample-and-hold `source` onto a locked `fps` Hz grid.
 *
 * Returns null when this engine cannot (no canvas.captureStream). The
 * share then goes out as Chrome delivered it; do not fail the picker.
 */
export async function lockScreenVideoToFps(
  source: MediaStreamTrack,
  fps: 30,
  dom: ScreenFrameLockDom | null = browserDom(),
): Promise<ScreenFrameLock | null> {
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
    const raw = mediaStreamSize(video, sourceSettings());
    const next = publishLockSize(raw.width, raw.height);
    if (canvas.width !== next.width || canvas.height !== next.height) {
      canvas.width = next.width;
      canvas.height = next.height;
    }
  };

  const draw = () => {
    if (!running || source.readyState === "ended") {
      return;
    }
    if (video.videoWidth > 0) {
      syncSize();
    }
    if (video.readyState >= 2 && canvas.width > 0 && canvas.height > 0) {
      ctx.drawImage(
        video as unknown as CanvasImageSource,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    }
  };

  let running = true;
  const unmount = mountHiddenVideo(video);

  video.muted = true;
  video.playsInline = true;
  video.srcObject = playbackStream(source);
  await waitForVideoFrame(video);
  if (!running) {
    unmount();
    video.srcObject = null;
    return null;
  }
  syncSize();
  draw();

  let lockedStream: { getVideoTracks(): MediaStreamTrack[] };
  try {
    lockedStream = canvas.captureStream(fps);
  } catch {
    running = false;
    video.srcObject = null;
    unmount();
    return null;
  }
  const track = lockedStream.getVideoTracks()[0];
  if (!track) {
    running = false;
    video.srcObject = null;
    unmount();
    return null;
  }

  const stopClock = startFrameClock(fps, draw);

  const nativeGetSettings =
    typeof track.getSettings === "function" ? track.getSettings.bind(track) : () => ({});
  track.getSettings = () => {
    const sourceNow = sourceSettings();
    return {
      ...nativeGetSettings(),
      displaySurface: sourceNow.displaySurface,
      cursor: sourceNow.cursor,
      logicalSurface: sourceNow.logicalSurface,
      width: canvas.width,
      height: canvas.height,
      frameRate: fps,
    };
  };

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
    unmount();
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
export async function lockScreenStreamToFps(
  stream: MediaStream,
  fps: 30,
  dom: ScreenFrameLockDom | null = browserDom(),
): Promise<ScreenFrameLock | null> {
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
  const lock = await lockScreenVideoToFps(source, fps, dom);
  if (!lock) {
    return null;
  }
  stream.removeTrack(source);
  stream.addTrack(lock.track);
  return lock;
}

export async function applyScreenFrameLock(
  stream: MediaStream,
  maxFrameRate: 30 | 60 | undefined,
  dom: ScreenFrameLockDom | null = browserDom(),
): Promise<ScreenFrameLock | null> {
  if (!shouldLockScreenFrameRate(maxFrameRate)) {
    return null;
  }
  return lockScreenStreamToFps(stream, 30, dom);
}

import {
  DEFAULT_PICTURE_THRESHOLDS,
  judgePicture,
  lumaFromRgba,
  type LumaGrid,
  type PictureSample,
  type PictureThresholds,
} from "./share-picture-check";

/**
 * Watches a live screen-share track for a dead picture (black, or no frames
 * at all) and says so once. The judgment is `share-picture-check.ts`; this is
 * the sampling around it.
 *
 * NOTHING IS REPORTED ON PIXELS ALONE. A verdict is only passed on once
 * `confirm()` (the desktop shell's `SHQueryUserNotificationState`) says a
 * Direct3D app holds the display in exclusive fullscreen right now. That is
 * what keeps a still slide (no frames under zero-hertz capture) and a film's
 * black hold out: neither is an exclusive-fullscreen Direct3D app. Unconfirmed,
 * the watch keeps looking until its window closes, and asks again at most
 * every `confirmEveryMs`.
 *
 * COST, which is the reason for every shape below:
 *   - Only the first `windowMs` (a minute) of a share, and a minute again after
 *     the track comes back from a mute or the caller re-arms it. Outside those
 *     windows nothing runs: the clone is stopped and the reader cancelled.
 *   - Frames are read from a CLONE of the track through
 *     `MediaStreamTrackProcessor` and closed at once. One frame in
 *     `intervalMs` (2 s) is drawn into a 32x18 canvas and read back: 576
 *     pixels, nothing kept, nothing uploaded, nothing leaves this function
 *     but a verdict.
 *   - A reader keeps counting frames while the window is behind a game (no
 *     paint, no `requestAnimationFrame`), which a `<video>` would not promise.
 *
 * Where `MediaStreamTrackProcessor` or `OffscreenCanvas` does not exist this
 * does nothing at all. The caller decides where it runs (the Windows desktop
 * app only, see `shouldWatchSharePicture`).
 */

export type DeadPictureKind = "black" | "stalled";

/**
 * The shell's answer to "is a Direct3D app in exclusive fullscreen right
 * now?": true, false, or null when it cannot tell (an older shell, PowerShell
 * refused). Only true lets a verdict through.
 */
export type ConfirmExclusiveFullscreen = () => Promise<boolean | null>;

export interface FrameReader {
  read(): Promise<{ done: boolean; value?: { close(): void } }>;
  cancel(): void;
}

export interface SharePictureWatchDeps {
  /** Opens a reader of frames for a clone of `track`; null when the engine has none. */
  openReader(track: MediaStreamTrack): { reader: FrameReader; stop(): void } | null;
  /** The frame's luma grid, or null when it cannot be read. */
  gridOf(frame: unknown): LumaGrid | null;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SharePictureWatchOptions {
  track: MediaStreamTrack;
  onDead(kind: DeadPictureKind): void;
  confirm: ConfirmExclusiveFullscreen;
  /** How often an unconfirmed verdict may ask the shell again. */
  confirmEveryMs?: number;
  windowMs?: number;
  intervalMs?: number;
  thresholds?: PictureThresholds;
  deps?: Partial<SharePictureWatchDeps>;
}

export interface SharePictureWatch {
  /** Start a fresh window of evidence (the source changed under the share). */
  rearm(): void;
  stop(): void;
  /** For `pqpShareHealth()` and tests. */
  status(): {
    running: boolean;
    reported: DeadPictureKind | null;
    frames: number;
    samples: number;
    /** The last verdict the pixels gave, confirmed or not. */
    suspected: "black" | "quiet" | null;
    /** The shell's last answer, null before it was asked or when it could not tell. */
    exclusiveFullscreen: boolean | null;
  };
}

const GRID_WIDTH = 32;
const GRID_HEIGHT = 18;

function defaultOpenReader(
  track: MediaStreamTrack,
): { reader: FrameReader; stop(): void } | null {
  const Processor = (globalThis as { MediaStreamTrackProcessor?: unknown })
    .MediaStreamTrackProcessor as
    | (new (init: { track: MediaStreamTrack }) => { readable: ReadableStream })
    | undefined;
  if (typeof Processor !== "function") {
    return null;
  }
  let clone: MediaStreamTrack;
  try {
    clone = track.clone();
  } catch {
    return null;
  }
  try {
    const reader = new Processor({ track: clone }).readable.getReader() as FrameReader;
    return {
      reader,
      stop() {
        try {
          reader.cancel();
        } catch {
          // Already cancelled.
        }
        clone.stop();
      },
    };
  } catch {
    clone.stop();
    return null;
  }
}

let gridCanvas: OffscreenCanvas | null = null;
let gridContext: OffscreenCanvasRenderingContext2D | null = null;

function defaultGridOf(frame: unknown): LumaGrid | null {
  if (typeof OffscreenCanvas !== "function") {
    return null;
  }
  try {
    if (!gridCanvas || !gridContext) {
      gridCanvas = new OffscreenCanvas(GRID_WIDTH, GRID_HEIGHT);
      gridContext = gridCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (!gridContext) {
      return null;
    }
    // "high" so the downscale averages the frame rather than picking 576
    // pixels out of two million: a bright object in a dark scene must reach
    // the grid.
    gridContext.imageSmoothingEnabled = true;
    gridContext.imageSmoothingQuality = "high";
    gridContext.drawImage(frame as CanvasImageSource, 0, 0, GRID_WIDTH, GRID_HEIGHT);
    return lumaFromRgba(gridContext.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT).data);
  } catch {
    return null;
  }
}

export function startSharePictureWatch(
  options: SharePictureWatchOptions,
): SharePictureWatch {
  const deps: SharePictureWatchDeps = {
    openReader: defaultOpenReader,
    gridOf: defaultGridOf,
    // The same clock the rest of the share code reads (the guard, the
    // controller); a minute-long window does not care about its resolution.
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    ...options.deps,
  };
  const windowMs = options.windowMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const thresholds = options.thresholds ?? DEFAULT_PICTURE_THRESHOLDS;
  const confirmEveryMs = options.confirmEveryMs ?? 6_000;
  const { track } = options;
  let suspected: "black" | "quiet" | null = null;
  let exclusiveFullscreen: boolean | null = null;
  let lastConfirmAt = Number.NEGATIVE_INFINITY;
  let confirming = false;

  let stopped = false;
  let reported: DeadPictureKind | null = null;
  let frames = 0;
  let pendingGrid: LumaGrid | null = null;
  let lastGridAt = Number.NEGATIVE_INFINITY;
  let samples: PictureSample[] = [];
  let windowStartedAt = 0;
  let timer: unknown = null;
  let open: { reader: FrameReader; stop(): void } | null = null;

  const closeWindow = () => {
    if (timer !== null) {
      deps.clearInterval(timer);
      timer = null;
    }
    open?.stop();
    open = null;
  };

  const pump = async (session: { reader: FrameReader }) => {
    for (;;) {
      let result: Awaited<ReturnType<FrameReader["read"]>>;
      try {
        result = await session.reader.read();
      } catch {
        return;
      }
      if (result.done || !result.value) {
        return;
      }
      const frame = result.value;
      if (open?.reader !== session.reader) {
        frame.close();
        return;
      }
      frames += 1;
      const now = deps.now();
      // At most one readback per half interval, so a 60 fps capture costs
      // one tiny draw per sample and 59 bare closes.
      if (now - lastGridAt >= intervalMs / 2) {
        lastGridAt = now;
        pendingGrid = deps.gridOf(frame) ?? pendingGrid;
      }
      frame.close();
    }
  };

  const tick = () => {
    if (stopped || reported) {
      closeWindow();
      return;
    }
    const now = deps.now();
    samples.push({ at: now, frames, luma: pendingGrid, muted: track.muted });
    pendingGrid = null;
    // Enough to cover `sustainMs` with room; older evidence is never read.
    const keep = Math.ceil(thresholds.sustainMs / intervalMs) + 3;
    if (samples.length > keep) {
      samples = samples.slice(-keep);
    }
    const verdict = judgePicture(samples, thresholds);
    suspected = verdict === "ok" ? null : verdict;
    if (verdict !== "ok" && !confirming && now - lastConfirmAt >= confirmEveryMs) {
      lastConfirmAt = now;
      confirming = true;
      const kind: DeadPictureKind = verdict === "black" ? "black" : "stalled";
      void options
        .confirm()
        .catch(() => null)
        .then((answer) => {
          confirming = false;
          exclusiveFullscreen = answer;
          // Re-checked after the wait: the share may have ended or the
          // picture may have come back meanwhile.
          if (answer !== true || stopped || reported || suspected === null) {
            return;
          }
          reported = kind;
          closeWindow();
          options.onDead(kind);
        });
    }
    if (now - windowStartedAt >= windowMs) {
      closeWindow();
    }
  };

  const openWindow = () => {
    if (stopped || reported || track.readyState === "ended") {
      return;
    }
    closeWindow();
    const next = deps.openReader(track);
    if (!next) {
      return;
    }
    open = next;
    frames = 0;
    pendingGrid = null;
    lastGridAt = Number.NEGATIVE_INFINITY;
    samples = [];
    windowStartedAt = deps.now();
    timer = deps.setInterval(tick, intervalMs);
    void pump(next);
  };

  // A mute is Chromium saying the source has nothing for now; the evidence
  // gathered before it says nothing about after. Start over on the way back.
  const onMute = () => closeWindow();
  const onUnmute = () => openWindow();
  track.addEventListener?.("mute", onMute);
  track.addEventListener?.("unmute", onUnmute);

  openWindow();

  return {
    rearm() {
      openWindow();
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      closeWindow();
      track.removeEventListener?.("mute", onMute);
      track.removeEventListener?.("unmute", onUnmute);
    },
    status() {
      return {
        running: open !== null,
        reported,
        frames,
        samples: samples.length,
        suspected,
        exclusiveFullscreen,
      };
    },
  };
}

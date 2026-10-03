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
 * Direct3D app holds the display in exclusive fullscreen right now, which
 * keeps a slide and a film's black hold out. A QUIET verdict (no frames) also
 * needs a failed refresh probe first, because a healthy capture of a STILL
 * game in fullscreen (a paused frame, a static menu) delivers no frames
 * either, and the fullscreen answer cannot tell that apart from a dead one.
 * Unconfirmed, the watch keeps looking until its window closes, and checks
 * again at most every `confirmEveryMs`.
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
  /**
   * Does the capture answer a refresh? True when a frame arrives on a fresh
   * sink within `ms` (or when it cannot be asked: no proof of death is not a
   * death), false when nothing arrives.
   */
  probe(track: MediaStreamTrack, ms: number): Promise<boolean>;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SharePictureWatchOptions {
  track: MediaStreamTrack;
  onDead(kind: DeadPictureKind): void;
  confirm: ConfirmExclusiveFullscreen;
  /** How often an unconfirmed verdict may be checked again. */
  confirmEveryMs?: number;
  /** How long a refresh probe waits for a frame. */
  probeMs?: number;
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
    /** Whether the last refresh probe got a frame back; null before one ran. */
    refreshAnswered: boolean | null;
    /** The shell's last answer, null before it was asked or when it could not tell. */
    exclusiveFullscreen: boolean | null;
  };
}

const GRID_WIDTH = 32;
const GRID_HEIGHT = 18;
/** A refresh frame is one capture away; three seconds covers a starved capturer too. */
const PROBE_MS = 3_000;

/**
 * Open a fresh reader on a new clone (a new sink, so Chromium requests a
 * refresh frame) and wait up to `ms` for one frame.
 */
async function defaultProbe(
  track: MediaStreamTrack,
  ms: number,
  openReader: SharePictureWatchDeps["openReader"],
): Promise<boolean> {
  const session = openReader(track);
  if (!session) {
    return true;
  }
  const wait: { timer?: ReturnType<typeof setTimeout> } = {};
  try {
    const frame = session.reader.read().then(
      (result) => {
        result.value?.close();
        return !result.done && Boolean(result.value);
      },
      () => false,
    );
    const timeout = new Promise<boolean>((resolve) => {
      wait.timer = setTimeout(() => resolve(false), ms);
    });
    return await Promise.race([frame, timeout]);
  } finally {
    clearTimeout(wait.timer);
    session.stop();
  }
}

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
    probe: (track, ms) => defaultProbe(track, ms, deps.openReader),
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
  const probeMs = options.probeMs ?? PROBE_MS;
  const { track } = options;
  let suspected: "black" | "quiet" | null = null;
  let exclusiveFullscreen: boolean | null = null;
  let refreshAnswered: boolean | null = null;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let checking = false;

  let stopped = false;
  let reported: DeadPictureKind | null = null;
  let frames = 0;
  let pendingGrid: LumaGrid | null = null;
  let lastGridAt = Number.NEGATIVE_INFINITY;
  let samples: PictureSample[] = [];
  let windowStartedAt = 0;
  let timer: unknown = null;
  let open: { reader: FrameReader; stop(): void } | null = null;
  /**
   * Which window of evidence is current. Bumped whenever a window opens or
   * closes, so a check that was started on one window (the probe and the
   * shell question are both asynchronous) can never report on another: a
   * mute, an unmute, a re-arm, the minute running out or the reader ending
   * all make its answer stale.
   */
  let generation = 0;

  const closeWindow = () => {
    generation += 1;
    suspected = null;
    if (timer !== null) {
      deps.clearInterval(timer);
      timer = null;
    }
    open?.stop();
    open = null;
  };

  // `session` is compared by identity: a reader object may be reused by an
  // engine (or a test), the session that opened it never is.
  const pump = async (session: { reader: FrameReader; stop(): void }) => {
    for (;;) {
      let result: Awaited<ReturnType<FrameReader["read"]>>;
      try {
        result = await session.reader.read();
      } catch {
        result = { done: true };
      }
      if (open !== session) {
        result.value?.close();
        return;
      }
      if (result.done || !result.value) {
        // The clone's stream ended (the share's track ended, or the engine
        // gave up on it). That is the controller's "ended" path, never
        // evidence of a stall: close the window so the frame count cannot
        // sit still into a QUIET verdict.
        closeWindow();
        return;
      }
      const frame = result.value;
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

  /**
   * One check of a suspicion, against the window it was raised in.
   *
   * QUIET first needs independent proof that the capture is dead, because a
   * healthy capture of anything still (a slide, or a paused game in
   * fullscreen) delivers no frames either. The proof is a refresh: a new sink
   * on the track makes Chromium ask the source for a frame
   * (`MediaStreamVideoTrack::AddSink` calls `RequestRefreshFrame`), and a
   * live capturer answers it even when nothing changed. No frame within
   * `probeMs` is a capture that cannot produce one. BLACK carries its own
   * proof in the pixels. Either way the shell then has to say a Direct3D app
   * holds the display in exclusive fullscreen, and the window, the verdict
   * and the share all have to be the same ones when the answers come back.
   */
  const check = async (verdict: "black" | "quiet", gen: number) => {
    const current = () => !stopped && !reported && gen === generation && suspected === verdict;
    if (verdict === "quiet") {
      const answered = await deps.probe(track, probeMs).catch(() => true);
      refreshAnswered = answered;
      if (answered || !current()) {
        return;
      }
    }
    const answer = await options.confirm().catch(() => null);
    exclusiveFullscreen = answer;
    if (answer !== true || !current()) {
      return;
    }
    const kind: DeadPictureKind = verdict === "black" ? "black" : "stalled";
    reported = kind;
    closeWindow();
    options.onDead(kind);
  };

  const tick = () => {
    if (stopped || reported || track.readyState === "ended") {
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
    if (verdict !== "ok" && !checking && now - lastCheckAt >= confirmEveryMs) {
      lastCheckAt = now;
      checking = true;
      void check(verdict, generation).finally(() => {
        checking = false;
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
        refreshAnswered,
        exclusiveFullscreen,
      };
    },
  };
}

/**
 * Does the picture a screen share is sending look dead? Pure, no DOM, no
 * timers: `share-picture-watch.ts` feeds it samples, and only acts on a
 * verdict once the desktop shell confirms a game holds the display in
 * exclusive fullscreen.
 *
 * Built for one report (2026-10): sharing Counter-Strike 2 from the Windows
 * desktop app works with the game in "Fullscreen Windowed" and not in plain
 * "Fullscreen". docs/DESKTOP.md §"Sharing a game: Fullscreen vs Fullscreen
 * Windowed" has the sources. What the viewer gets then is one of three
 * things, and this module names the two a sample can show:
 *
 *   - BLACK: every frame is black. Chromium's screen capturer below Windows 11
 *     24H2 is DXGI duplication with a GDI fallback, and an exclusive-fullscreen
 *     game takes the output away from the compositor both of them read.
 *   - QUIET: the capturer handed over no frame at all for `sustainMs`. The
 *     viewer keeps the last one, frozen. That is ALSO what a healthy capture
 *     of a still picture looks like: Chromium 152's desktop capturer runs in
 *     "zero hertz" mode and does not deliver a frame whose content did not
 *     change (`desktop_capture_device.cc`, `zero_hertz_is_active`). So QUIET
 *     on its own proves nothing and is never shown to anybody unconfirmed.
 *
 * (The third, a capture that ends, is the track's own `ended` event.)
 *
 * WHAT MUST NOT FIRE, and the rule that keeps each one out (pinned by
 * synthetic frames in `share-picture-check.test.ts`):
 *
 *   - A dark film scene. Dark is not black: a night shot still has
 *     highlights (the top of the luma distribution), grain, and motion
 *     between samples. BLACK needs the whole frame near zero AND the frame
 *     not to move, for `sustainMs`.
 *   - A still slide, a paused video, an idle desktop. These are QUIET, and
 *     the watch only reports QUIET when the shell says a Direct3D
 *     exclusive-fullscreen app is running (`SHQueryUserNotificationState`),
 *     which a slide, a paused video or a desktop is not.
 *   - A share that has only just started or just came back from a mute. The
 *     evidence must be continuous for `sustainMs`, and anything that is not
 *     a bad sample (a moving frame) starts it over.
 */

/** A small luma grid of one captured frame, row-major, 0..255. */
export type LumaGrid = ArrayLike<number>;

export interface PictureSample {
  /** Monotonic ms. */
  at: number;
  /**
   * Frames the capture has delivered since the watch began, cumulative. Null
   * when this engine cannot count them (then QUIET is never concluded).
   */
  frames: number | null;
  /**
   * The luma grid of the newest frame seen since the previous sample, or
   * null when no frame arrived in between (or it could not be read).
   */
  luma: LumaGrid | null;
  /** The track was muted (`track.muted`) when the sample was taken. */
  muted?: boolean;
}

export type PictureVerdict = "ok" | "black" | "quiet";

export interface PictureThresholds {
  /** How long the evidence has to hold, continuously. */
  sustainMs: number;
  /** BLACK: mean luma at or under this (0..255). */
  blackMean: number;
  /** BLACK: the 98th percentile at or under this, so a cursor drawn into a black capture still counts as black. */
  blackP98: number;
  /** BLACK: mean absolute difference from the previous grid at or under this. */
  blackStillDiff: number;
}

/**
 * Thresholds, and why each sits where it does:
 *
 * - `sustainMs` 8 s: four samples at the watch's 2 s pace, long enough that a
 *   film's fade to black and a game's loading screen pass, short enough that
 *   the presenter hears about it while they are still setting up.
 * - `blackMean` 4 and `blackP98` 12: a failed capture is RGB 0 everywhere. A
 *   dark film scene measured as a mean of 10 to 25 with highlights well over
 *   40; the fixtures in the test sit on both sides of the line.
 * - `blackStillDiff` 0.75: zeros do not move. Film grain and compression
 *   noise move a dark scene by more than that between two samples.
 */
export const DEFAULT_PICTURE_THRESHOLDS: PictureThresholds = {
  sustainMs: 8_000,
  blackMean: 4,
  blackP98: 12,
  blackStillDiff: 0.75,
};

export interface LumaStats {
  mean: number;
  p98: number;
}

export function lumaStats(grid: LumaGrid): LumaStats {
  const n = grid.length;
  if (n === 0) {
    return { mean: 0, p98: 0 };
  }
  const sorted = Array.from(grid).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += sorted[i];
  }
  const index = Math.min(n - 1, Math.floor(n * 0.98));
  return { mean: sum / n, p98: sorted[index] };
}

/** Mean absolute difference of two grids of the same size; Infinity when they cannot be compared. */
export function lumaDiff(a: LumaGrid, b: LumaGrid): number {
  if (a.length !== b.length || a.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
}

/**
 * BT.601 luma of RGBA pixels (canvas `getImageData` order), one value per
 * pixel. Alpha is ignored: a capture is opaque.
 */
export function lumaFromRgba(rgba: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.floor(rgba.length / 4));
  for (let p = 0, i = 0; p < out.length; p += 1, i += 4) {
    out[p] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return out;
}

function isBlackGrid(grid: LumaGrid, t: PictureThresholds): boolean {
  const stats = lumaStats(grid);
  return stats.mean <= t.blackMean && stats.p98 <= t.blackP98;
}

/**
 * The verdict over a run of samples, oldest first. Looks for the most recent
 * unbroken stretch of black samples, and of samples with no new frame,
 * reaching back at least `sustainMs`. `ok` is also the answer for "not
 * enough evidence yet".
 */
export function judgePicture(
  samples: readonly PictureSample[],
  thresholds: PictureThresholds = DEFAULT_PICTURE_THRESHOLDS,
): PictureVerdict {
  if (samples.length < 2) {
    return "ok";
  }
  const last = samples[samples.length - 1];

  // QUIET: walk back while the frame count did not move and the track was
  // unmuted. (Chromium 152 does not mute a capture track that stops
  // delivering, `kMediaStreamTrackEmptyVideoFrameMonitor`; a mute is some
  // other source state and is left alone.)
  if (last.frames !== null && last.muted !== true) {
    let since = last.at;
    for (let i = samples.length - 2; i >= 0; i -= 1) {
      const s = samples[i];
      if (s.frames === null || s.frames !== last.frames || s.muted === true) {
        break;
      }
      since = s.at;
    }
    if (last.at - since >= thresholds.sustainMs) {
      return "quiet";
    }
  }

  // BLACK: walk back while every sample is black and still against the one
  // before it. A sample with no new grid (no frame arrived) neither extends
  // nor breaks the run: the picture the viewer has is the last one.
  let blackSince: number | null = null;
  let newerGrid: LumaGrid | null = null;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i];
    if (!s.luma) {
      continue;
    }
    if (!isBlackGrid(s.luma, thresholds)) {
      break;
    }
    // Black AND still against the newer grid: zeros do not move.
    if (newerGrid !== null && lumaDiff(newerGrid, s.luma) > thresholds.blackStillDiff) {
      break;
    }
    blackSince = s.at;
    newerGrid = s.luma;
  }
  if (blackSince !== null && last.at - blackSince >= thresholds.sustainMs) {
    return "black";
  }
  return "ok";
}

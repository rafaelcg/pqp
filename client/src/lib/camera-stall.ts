/**
 * Stall recovery for the presenter's camera (`WatchCameraPip`). Pure: samples
 * and a clock in, one action out, so the policy is unit-testable without a
 * `<video>`.
 *
 * WHY THE CAMERA NEEDS ONE AT ALL. The film has `HlsStallWatch`
 * (`hls-stall.ts`), a thousand lines of ladder, reconnects to a restarted
 * session and a dead screen. The camera deliberately has none of that, and
 * rehearsal D (2026-09-25, 13:48:22Z) showed the cost: the webcam froze at
 * t=18.07 with `paused: false` and stayed on that frame for the rest of the
 * show, while its playlist kept advancing on the server (the camera recording
 * has no gap there). hls.js never raised a fatal error, so nothing in the
 * component ever looked again.
 *
 * WHAT THIS IS, AND IS NOT. It never asks the server anything and never
 * decides the camera is gone: `cameraHlsUrl` disappearing off the next stream
 * frame is what unmounts the camera, and that stays the only way it ends. All
 * this does is notice that playback stopped moving while the camera is still
 * announced, and answer with the two cheapest things that work.
 *
 * WHAT "MOVING" MEANS. Decoded video frames when a picture is expected, the
 * media clock (`currentTime`) otherwise. The clock alone is not enough once
 * the playlist carries the presenter's voice ("separada"): audio keeps
 * `currentTime` advancing while the picture is frozen (Farol, PR 826), which
 * is exactly the face that needs recovering. The frame counter falls back to
 * the clock where `getVideoPlaybackQuality` does not exist, and the voice-only
 * shape has no picture to count, so it uses the clock too.
 *
 *
 * 1. `"nudge"` once per episode, after `stallMs` with no movement: the caller
 *    restarts loading at the live edge (`startLoad(-1)`) and seeks there if
 *    the element sits behind it. That clears a buffer hole or a loader that
 *    gave up, without dropping anything.
 * 2. `"rebuild"`, `backoffMs[level]` after the previous action if the picture
 *    is still frozen: a fresh hls.js instance on the freshest URL. Each
 *    rebuild moves one step up the backoff and every delay carries jitter,
 *    because when the camera egress hiccups every viewer freezes in the same
 *    second, and five hundred rebuilds in the same second is a stampede on
 *    the playlist proxy.
 *
 * NEVER A TIGHT LOOP. Two rebuilds are always at least `backoffMs[0]` apart
 * (less the jitter), and at least `stallMs` of no movement has to come first
 * every time. The backoff only resets once the camera has played forward for
 * `healthyMs` straight, so a rebuild that paints one frame and freezes again
 * does not start the ladder over. At the ceiling it is one manifest request
 * every couple of minutes per viewer, for as long as the server keeps
 * announcing a camera that does not play.
 *
 * NOT COUNTED: a hidden page (browsers throttle and pause background media,
 * and nobody is looking), and an element waiting for a gesture (the "tap to
 * hear" state, where a refused unmuted `play()` is the reason it is not
 * moving and a rebuild would only be refused again).
 */

export type CameraStallAction = "none" | "nudge" | "rebuild";

export interface CameraStallSample {
  /**
   * A clock that moves while the camera plays: decoded frames, or
   * `currentTime` in seconds. Only its movement matters, never its unit.
   */
  position: number;
  /** Whether a stall right now should count. See the file doc. */
  eligible: boolean;
}

export interface CameraStallOptions {
  now: () => number;
  /** 0..1, jitter source. Injected so tests can pin it. */
  random?: () => number;
  stallMs?: number;
  backoffMs?: readonly number[];
  healthyMs?: number;
  /** Fraction each backoff delay may move either way. */
  jitter?: number;
}

/** How often the component samples the element. */
export const CAMERA_STALL_POLL_MS = 2_000;
/**
 * No movement for this long is a stall. Four camera segments are 16 s, so
 * 8 s is two segments of silence: well past a slow poll, well short of
 * "someone noticed the face is frozen".
 */
export const CAMERA_STALL_MS = 8_000;
/** Delay after the previous action before each rebuild, in order. */
export const CAMERA_REBUILD_BACKOFF_MS: readonly number[] = [
  8_000, 15_000, 30_000, 60_000, 120_000,
];
/** Forward play for this long means the camera is healthy again. */
export const CAMERA_HEALTHY_MS = 10_000;
export const CAMERA_REBUILD_JITTER = 0.25;

/** Smaller than any real frame step, larger than float noise. */
const MOVED_EPSILON_S = 0.01;

export class CameraStallWatch {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly stallMs: number;
  private readonly backoffMs: readonly number[];
  private readonly healthyMs: number;
  private readonly jitter: number;

  private lastTime: number | null = null;
  private lastMovedAt = 0;
  private advancingSince: number | null = null;
  private nudged = false;
  private level = 0;
  private actionAt = 0;
  private nextDelayMs = 0;

  constructor(options: CameraStallOptions) {
    this.now = options.now;
    this.random = options.random ?? Math.random;
    this.stallMs = options.stallMs ?? CAMERA_STALL_MS;
    this.backoffMs = options.backoffMs ?? CAMERA_REBUILD_BACKOFF_MS;
    this.healthyMs = options.healthyMs ?? CAMERA_HEALTHY_MS;
    this.jitter = options.jitter ?? CAMERA_REBUILD_JITTER;
  }

  /** How many rebuilds this episode has spent. For logs and tests. */
  get rebuilds(): number {
    return this.level;
  }

  observe(sample: CameraStallSample): CameraStallAction {
    const now = this.now();
    if (!sample.eligible || !Number.isFinite(sample.position)) {
      // Forget the baseline, keep the episode: the next eligible sample
      // starts a fresh stall clock, so coming back to the tab never fires on
      // time spent away from it.
      this.lastTime = null;
      this.advancingSince = null;
      return "none";
    }
    const previous = this.lastTime;
    this.lastTime = sample.position;
    if (previous === null) {
      this.lastMovedAt = now;
      return "none";
    }
    if (Math.abs(sample.position - previous) > MOVED_EPSILON_S) {
      this.lastMovedAt = now;
      if (sample.position > previous) {
        this.advancingSince ??= now;
        if (now - this.advancingSince >= this.healthyMs) {
          this.nudged = false;
          this.level = 0;
        }
      } else {
        // Backwards: a rebuild's fresh timeline, or a seek. Movement, not
        // proof of health.
        this.advancingSince = null;
      }
      return "none";
    }
    this.advancingSince = null;
    if (now - this.lastMovedAt < this.stallMs) {
      return "none";
    }
    if (!this.nudged) {
      this.nudged = true;
      this.arm(now);
      return "nudge";
    }
    if (now - this.actionAt < this.nextDelayMs) {
      return "none";
    }
    this.level += 1;
    this.arm(now);
    // The caller tears the element down; its clock drops to 0, and
    // that must not read as the camera moving.
    this.lastTime = null;
    return "rebuild";
  }

  private arm(now: number): void {
    this.actionAt = now;
    const base =
      this.backoffMs[Math.min(this.level, this.backoffMs.length - 1)] ?? 0;
    const spread = (this.random() * 2 - 1) * this.jitter;
    this.nextDelayMs = Math.max(0, Math.round(base * (1 + spread)));
  }
}

/**
 * The progress clock to sample. See "WHAT MOVING MEANS" in the file doc.
 * `totalVideoFrames` is reset by the element's load algorithm, so a rebuild
 * reads as a drop to 0, which `observe` already treats as a new baseline.
 */
export function cameraProgress(
  video: Pick<HTMLVideoElement, "currentTime"> & {
    getVideoPlaybackQuality?: () => { totalVideoFrames: number };
  },
  expectPicture: boolean,
): number {
  if (expectPicture && typeof video.getVideoPlaybackQuality === "function") {
    try {
      const frames = video.getVideoPlaybackQuality().totalVideoFrames;
      if (Number.isFinite(frames)) {
        return frames;
      }
    } catch {
      // Fall through to the clock.
    }
  }
  return video.currentTime;
}

import {
  buildShareGuardLadder,
  createShareGuard,
  deriveShareSample,
  readShareEncodeStats,
  type ShareEncodeStats,
  type ShareFps,
  type ShareGuard,
  type ShareGuardConfig,
  type ShareGuardDecision,
  type ShareGuardLevel,
  type ShareGuardSample,
  type ShareGuardSnapshot,
} from "./share-high-motion-guard";

/**
 * The running half of `share_high_motion_guard`: samples the share's encoder on
 * a timer, hands the readings to the state machine, and applies the level it
 * picks. Everything it touches is passed in, so a test drives it with a fake
 * clock, fake stats and a fake track.
 *
 * WHAT A STEP DOES. Three things, all in place, none of them a restart:
 *
 *  1. `applyConstraints` on the capture track, with the constraints the
 *     capture was opened with laid under the level's frame rate and height
 *     ceiling. `applyConstraints` REPLACES the constraint set, so the original
 *     set is snapshotted once and every step is written over it; writing a
 *     bare `{ height }` would silently drop the width ceiling and the cursor
 *     request.
 *  2. The transport's encoder half (`applyCeiling`): a frame-rate ceiling on
 *     the senders and a scale on the bitrate ceiling.
 *  3. A log line. Low volume by construction: only a step, never a reading.
 *
 * It never throws and never stops a track. A browser that refuses a constraint
 * leaves the capture as it was, and the share carries on.
 */

export interface ShareGuardTransport {
  /** One stats report per outbound sender of the share (several on a mesh call). */
  readReports(): Promise<Array<Iterable<unknown>>>;
  /** The encoder half of a level. Null lifts the guard's hold entirely. */
  applyCeiling(level: ShareGuardLevel | null): Promise<void>;
  /**
   * True while something else owns this share's encoder (a watch party is
   * transcoding from it). The guard then gives the share back and stops for
   * good: a party's ingest has its own rules and the guard must never move it.
   */
  blocked?(): boolean;
}

export interface ShareGuardTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ShareGuardOptions {
  track: MediaStreamTrack;
  transport: ShareGuardTransport;
  /** What the presenter asked the capture for. */
  baseFps: ShareFps;
  intervalMs?: number;
  now?: () => number;
  timers?: ShareGuardTimers;
  config?: ShareGuardConfig;
  log?: (message: string, detail: Record<string, unknown>) => void;
}

export interface ShareGuardHandle {
  stop(): Promise<void>;
  /** One sampling pass. The timer calls it; a test calls it directly. */
  tick(): Promise<ShareGuardDecision | null>;
  level(): ShareGuardLevel;
  snapshot(): ShareGuardSnapshot;
  /** Move to a level by hand (`pqpShareHealth.force`). Null goes back to the top. */
  force(index: number | null): Promise<ShareGuardLevel>;
  /** The presenter changed the capture rate: start the ladder over from it. */
  rebase(baseFps: ShareFps): Promise<void>;
  /** Put the current level back onto the capture (after something else wrote to it). */
  reapply(): Promise<void>;
}

export const SHARE_GUARD_INTERVAL_MS = 2_000;

function readTrackHeight(track: MediaStreamTrack): number | null {
  try {
    const height =
      typeof track.getSettings === "function"
        ? track.getSettings().height
        : undefined;
    return typeof height === "number" && height > 0 ? height : null;
  } catch {
    return null;
  }
}

function snapshotConstraints(track: MediaStreamTrack): MediaTrackConstraints {
  try {
    return typeof track.getConstraints === "function"
      ? { ...track.getConstraints() }
      : {};
  } catch {
    return {};
  }
}

/** The capture's own constraints with a level's frame rate and height laid over them. */
export function captureConstraintsFor(
  base: MediaTrackConstraints,
  level: ShareGuardLevel,
): MediaTrackConstraints {
  const next: MediaTrackConstraints = {
    ...base,
    frameRate: { ideal: level.maxFps, max: level.maxFps },
  };
  if (level.maxHeight !== null) {
    const previous = base.height;
    const previousMax =
      typeof previous === "object" && previous !== null && typeof previous.max === "number"
        ? previous.max
        : Number.POSITIVE_INFINITY;
    next.height = {
      ...(typeof previous === "object" && previous !== null ? previous : {}),
      max: Math.min(previousMax, level.maxHeight),
    };
  }
  return next;
}

/**
 * Make sure the capture is really bounded at `maxFps`.
 *
 * The request already carries `frameRate: { ideal, max }`, and Chromium paces
 * its desktop capturer off it (`DesktopCaptureDevice`: a timer at the requested
 * rate, stretched to twice the last capture's duration). But a constraint is a
 * request and `getSettings()` is the answer, and a capture that reports more
 * than asked for, or nothing, is one whose pacing we cannot vouch for. So this
 * reads the answer and, when it is over or absent, asks again in place. The
 * result is for `pqpShareHealth`; it never throws.
 */
export async function enforceCaptureFrameRate(
  track: MediaStreamTrack,
  maxFps: ShareFps,
): Promise<{
  requested: ShareFps;
  reported: number | null;
  enforced: boolean;
  after: number | null;
}> {
  const read = (): number | null => {
    try {
      const fps = track.getSettings().frameRate;
      return typeof fps === "number" && Number.isFinite(fps) ? fps : null;
    } catch {
      return null;
    }
  };
  const reported = read();
  if (reported !== null && reported <= maxFps + 1) {
    return { requested: maxFps, reported, enforced: false, after: reported };
  }
  try {
    await track.applyConstraints({
      ...snapshotConstraints(track),
      frameRate: { ideal: maxFps, max: maxFps },
    });
  } catch {
    return { requested: maxFps, reported, enforced: true, after: read() };
  }
  return { requested: maxFps, reported, enforced: true, after: read() };
}

const DEFAULT_TIMERS: ShareGuardTimers = {
  set: (run, ms) => setInterval(run, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function startShareGuard(options: ShareGuardOptions): ShareGuardHandle {
  const { track, transport } = options;
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? DEFAULT_TIMERS;
  // A warning, not info: a step is worth seeing in a presenter's console, and
  // it is bounded by the machine's own back-off (one line per step).
  const log = options.log ?? ((message, detail) => console.warn(message, detail));
  const baseConstraints = snapshotConstraints(track);
  const baseHeight = readTrackHeight(track);
  let ladder = buildShareGuardLadder({ fps: options.baseFps, height: baseHeight });
  const guard: ShareGuard = createShareGuard(ladder, options.config);
  let previous: Array<ShareEncodeStats | null> = [];
  let busy = false;
  let stopped = false;

  async function applyLevel(level: ShareGuardLevel): Promise<void> {
    if (typeof track.applyConstraints === "function") {
      try {
        await track.applyConstraints(captureConstraintsFor(baseConstraints, level));
      } catch (err) {
        // The capture keeps what it had. The encoder half below still lowers
        // the send rate and bitrate, which is most of the benefit.
        log("[pqp] share guard: capture kept its settings", {
          level: level.index,
          error: err instanceof Error ? err.name : String(err),
        });
      }
    }
    try {
      await transport.applyCeiling(level.index === 0 ? null : level);
    } catch (err) {
      log("[pqp] share guard: senders kept their ceiling", {
        level: level.index,
        error: err instanceof Error ? err.name : String(err),
      });
    }
  }

  function describe(level: ShareGuardLevel): Record<string, unknown> {
    let settings: { frameRate?: number; height?: number } = {};
    try {
      settings = track.getSettings();
    } catch {
      settings = {};
    }
    return {
      level: level.index,
      of: ladder.length - 1,
      step: level.step,
      maxFps: level.maxFps,
      maxHeight: level.maxHeight,
      bitrateScale: level.bitrateScale,
      captureFps: settings.frameRate ?? null,
      captureHeight: settings.height ?? null,
    };
  }

  async function tick(): Promise<ShareGuardDecision | null> {
    if (busy || stopped) {
      return null;
    }
    if (transport.blocked?.()) {
      await api.stop();
      return null;
    }
    busy = true;
    try {
      let reports: Array<Iterable<unknown>> = [];
      try {
        reports = await transport.readReports();
      } catch {
        reports = [];
      }
      if (stopped) {
        return null;
      }
      const at = now();
      const next: Array<ShareEncodeStats | null> = [];
      const samples: ShareGuardSample[] = [];
      reports.forEach((report, sender) => {
        const reading = readShareEncodeStats(report, at);
        next[sender] = reading;
        if (reading) {
          samples.push(deriveShareSample(previous[sender] ?? null, reading));
        }
      });
      previous = next;
      if (samples.length === 0) {
        return null;
      }
      const decision = guard.observe(samples);
      if (decision.action !== "hold") {
        await applyLevel(decision.level);
        log(
          decision.action === "down"
            ? "[pqp] share guard: stepped down"
            : "[pqp] share guard: stepped up",
          { ...describe(decision.level), verdict: decision.verdict, reason: decision.reason },
        );
      }
      return decision;
    } finally {
      busy = false;
    }
  }

  const handle = timers.set(() => {
    void tick();
  }, options.intervalMs ?? SHARE_GUARD_INTERVAL_MS);

  const api: ShareGuardHandle = {
    tick,
    level: () => guard.level(),
    snapshot: () => guard.snapshot(),
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      timers.clear(handle);
      const wasLowered = guard.level().index > 0;
      // Hand the senders back whatever they were held to.
      try {
        await transport.applyCeiling(null);
      } catch {
        // The share is going away anyway.
      }
      // A capture that is still live (the guard stopped because a party took
      // the share over, not because the share ended) gets its own settings
      // back. An ended track has nothing to restore, and is left alone.
      if (
        wasLowered &&
        track.readyState === "live" &&
        typeof track.applyConstraints === "function"
      ) {
        try {
          await track.applyConstraints(baseConstraints);
        } catch {
          // Keeps what it has.
        }
      }
    },
    async force(index) {
      const level = guard.force(index, now());
      await applyLevel(level);
      log("[pqp] share guard: set by hand", describe(level));
      return level;
    },
    async rebase(baseFps) {
      ladder = buildShareGuardLadder({ fps: baseFps, height: baseHeight });
      const top = guard.rebase(ladder);
      previous = [];
      await applyLevel(top);
    },
    async reapply() {
      await applyLevel(guard.level());
    },
  };
  return api;
}

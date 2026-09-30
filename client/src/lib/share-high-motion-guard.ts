/**
 * The decision half of `share_high_motion_guard`: is this presenter's screen
 * share being starved, and what should it be stepped down to. Pure: no timers,
 * no stats reads, no DOM. `share-guard-runtime.ts` feeds it and applies what it
 * says.
 *
 * WHY IT EXISTS. A game at several hundred frames per second keeps the GPU at
 * 100 %. The share's capture (a readback of the newest frame, paced by the
 * `frameRate` constraint and stretched to twice its own duration when a call is
 * slow), its colour conversion and its encode all need slices of that same GPU
 * and of the CPU cores the game is using, and they are the ones that lose.
 * The viewer sees stalls. Capping the game at 60 fixes it, which is not an
 * answer we are willing to give: the pipeline has to cope with what it is
 * given.
 *
 * WHAT IT DOES NOT DO: blame anybody. There is nothing user-facing here.
 *
 * THE LADDER, in the order the presenter's picture is spent (games are motion
 * content, so frame rate is the last thing to go and the first to come back):
 *
 *   0. what the presenter asked for
 *   1. resolution one rung down, bitrate scaled with it
 *   2. resolution two rungs down
 *   3. frame rate 60 to 30 (only when the capture was 60)
 *
 * HYSTERESIS, because a guard that oscillates is worse than no guard: a step
 * down needs about 5 s of sustained starvation; a step up needs 45 s of
 * health, with projected headroom at the higher level; every up-step that is
 * followed by a down-step inside 90 s doubles the wait for the next one, and
 * after three of those the share stays where it is for good.
 */

export type ShareFps = 30 | 60;

export interface ShareGuardLevel {
  /** Position in the ladder. 0 is what the presenter asked for. */
  index: number;
  maxFps: ShareFps;
  /** Capture height ceiling in lines, or null when the guard has not lowered it. */
  maxHeight: number | null;
  /** The picture height this level works out to, for projections. */
  height: number;
  /** Multiplier on the screen's bitrate ceiling. */
  bitrateScale: number;
  /** What this level changed compared with the one above it. */
  step: "base" | "resolution" | "frame-rate";
}

/**
 * What a transport needs to know to hold a share under the guard's current
 * step: the encoder half of a level. The capture half (`applyConstraints`) is
 * the runtime's, because the track is the same on every transport.
 */
export type ShareGuardCeiling = Pick<ShareGuardLevel, "maxFps" | "maxHeight" | "bitrateScale">;

/** Heights the guard will step a capture down to, and what each costs in bits. */
const RESOLUTION_RUNGS: ReadonlyArray<{ height: number; bitrateScale: number }> = [
  { height: 720, bitrateScale: 0.65 },
  { height: 540, bitrateScale: 0.45 },
];

/** A rung has to be at least this many lines under the capture to be a step. */
const MIN_RUNG_GAP = 100;

/** When the capture's height is unknown the request's own ceiling is the best guess. */
const ASSUMED_HEIGHT = 1080;

export function buildShareGuardLadder(base: {
  fps: ShareFps;
  height: number | null;
}): ShareGuardLevel[] {
  const baseHeight =
    typeof base.height === "number" && base.height > 0
      ? Math.round(base.height)
      : ASSUMED_HEIGHT;
  const ladder: ShareGuardLevel[] = [
    {
      index: 0,
      maxFps: base.fps,
      maxHeight: null,
      height: baseHeight,
      bitrateScale: 1,
      step: "base",
    },
  ];
  for (const rung of RESOLUTION_RUNGS) {
    if (baseHeight - rung.height < MIN_RUNG_GAP) {
      continue;
    }
    ladder.push({
      index: ladder.length,
      maxFps: base.fps,
      maxHeight: rung.height,
      height: rung.height,
      bitrateScale: rung.bitrateScale,
      step: "resolution",
    });
  }
  if (base.fps === 60) {
    const last = ladder[ladder.length - 1]!;
    ladder.push({
      index: ladder.length,
      maxFps: 30,
      maxHeight: last.maxHeight,
      height: last.height,
      bitrateScale: last.bitrateScale,
      step: "frame-rate",
    });
  }
  return ladder;
}

// ------------------------------------------------------------------ stats

/** One cumulative reading of the share's top outbound video stream. */
export interface ShareEncodeStats {
  at: number;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  framesEncoded: number | null;
  /** Cumulative seconds the encoder spent on frames. */
  totalEncodeTime: number | null;
  bytesSent: number | null;
  targetBitrate: number | null;
  qualityLimitationReason: string | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  /** `video/H264`, `video/VP8`, and so on. */
  codec: string | null;
  /** What the capture handed the sender, frames per second. */
  sourceFps: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
}

interface StatLike {
  id?: string;
  type?: string;
  kind?: string;
  mediaType?: string;
  rid?: string;
  active?: boolean;
  mediaSourceId?: string;
  codecId?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesEncoded?: number;
  totalEncodeTime?: number;
  bytesSent?: number;
  targetBitrate?: number;
  qualityLimitationReason?: string;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  mimeType?: string;
  width?: number;
  height?: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function entriesOf(report: Iterable<unknown>): StatLike[] {
  const out: StatLike[] = [];
  for (const entry of report) {
    const stat = (Array.isArray(entry) ? entry[1] : entry) as StatLike | undefined;
    if (stat && typeof stat === "object") {
      out.push(stat);
    }
  }
  return out;
}

/**
 * Read the top outbound video stream of one sender's stats report, with the
 * codec and media-source entries it points at. A simulcast sender has one
 * `outbound-rtp` per layer: the tallest one is the share itself.
 */
export function readShareEncodeStats(
  report: Iterable<unknown>,
  at: number,
): ShareEncodeStats | null {
  const stats = entriesOf(report);
  let top: StatLike | null = null;
  for (const stat of stats) {
    if (stat.type !== "outbound-rtp") {
      continue;
    }
    if ((stat.kind ?? stat.mediaType) !== "video" || stat.active === false) {
      continue;
    }
    if (
      top === null ||
      (stat.frameWidth ?? 0) > (top.frameWidth ?? 0) ||
      ((stat.frameWidth ?? 0) === (top.frameWidth ?? 0) &&
        (stat.bytesSent ?? 0) > (top.bytesSent ?? 0))
    ) {
      top = stat;
    }
  }
  if (!top) {
    return null;
  }
  const source = stats.find(
    (stat) => stat.type === "media-source" && stat.id === top!.mediaSourceId,
  );
  const codec = stats.find(
    (stat) => stat.type === "codec" && stat.id === top!.codecId,
  );
  return {
    at,
    frameWidth: num(top.frameWidth),
    frameHeight: num(top.frameHeight),
    framesPerSecond: num(top.framesPerSecond),
    framesEncoded: num(top.framesEncoded),
    totalEncodeTime: num(top.totalEncodeTime),
    bytesSent: num(top.bytesSent),
    targetBitrate: num(top.targetBitrate),
    qualityLimitationReason:
      typeof top.qualityLimitationReason === "string"
        ? top.qualityLimitationReason
        : null,
    encoderImplementation:
      typeof top.encoderImplementation === "string"
        ? top.encoderImplementation
        : null,
    powerEfficientEncoder:
      typeof top.powerEfficientEncoder === "boolean"
        ? top.powerEfficientEncoder
        : null,
    codec: typeof codec?.mimeType === "string" ? codec.mimeType : null,
    sourceFps: num(source?.framesPerSecond),
    sourceWidth: num(source?.width),
    sourceHeight: num(source?.height),
  };
}

/** What happened between two readings, in numbers the judge can use. */
export interface ShareGuardSample {
  at: number;
  /** Frames per second leaving the encoder. */
  fps: number | null;
  /** Frames per second the capture handed over. */
  sourceFps: number | null;
  /** Mean milliseconds the encoder spent per frame since the last reading. */
  encodeMs: number | null;
  kbps: number | null;
  targetKbps: number | null;
  limitedBy: string | null;
  height: number | null;
}

/** Fewer encoded frames than this between two readings say nothing about cost. */
const MIN_FRAMES_FOR_ENCODE_TIME = 5;

export function deriveShareSample(
  previous: ShareEncodeStats | null,
  current: ShareEncodeStats,
): ShareGuardSample {
  let encodeMs: number | null = null;
  let kbps: number | null = null;
  let fps = current.framesPerSecond;
  if (previous && current.at > previous.at) {
    const seconds = (current.at - previous.at) / 1000;
    if (
      current.framesEncoded !== null &&
      previous.framesEncoded !== null &&
      current.totalEncodeTime !== null &&
      previous.totalEncodeTime !== null
    ) {
      const frames = current.framesEncoded - previous.framesEncoded;
      const spent = current.totalEncodeTime - previous.totalEncodeTime;
      if (frames >= MIN_FRAMES_FOR_ENCODE_TIME && spent >= 0) {
        encodeMs = (spent * 1000) / frames;
      }
      if (fps === null && frames >= 0) {
        fps = frames / seconds;
      }
    }
    if (current.bytesSent !== null && previous.bytesSent !== null) {
      const bytes = current.bytesSent - previous.bytesSent;
      if (bytes >= 0) {
        kbps = (bytes * 8) / seconds / 1000;
      }
    }
  }
  return {
    at: current.at,
    fps,
    sourceFps: current.sourceFps,
    encodeMs,
    kbps,
    targetKbps:
      current.targetBitrate === null ? null : current.targetBitrate / 1000,
    limitedBy: current.qualityLimitationReason,
    height: current.frameHeight,
  };
}

// ------------------------------------------------------------------ verdict

export type ShareGuardVerdict =
  /** Delivering what it was asked for, or the picture is simply still. */
  | "healthy"
  /** The encoder is behind: cpu limitation, frames costing more than their slot, or frames lost after the capture. */
  | "starved-encoder"
  /** Few frames come out of the capture and the ones that do are large: the capture is behind. */
  | "starved-capture"
  /** The link is the limit. Not this guard's business, and it is not evidence of health either. */
  | "network"
  /** Not enough readings yet. */
  | "unknown";

export interface ShareGuardJudgement {
  verdict: ShareGuardVerdict;
  reason: "cpu-limited" | "encode-time" | "low-fps" | null;
}

/** Sent below this fraction of the target rate counts as behind. */
const LOW_FPS_FRACTION = 0.5;
/**
 * An encode longer than this fraction of the frame slot is SLOW, and slow
 * alone proves nothing: `totalEncodeTime` counts a frame from the encode call
 * to its completion, and an asynchronous hardware encoder (Media Foundation
 * keeps several frames in flight) legitimately shows 15 to 30 ms a frame at
 * 60 fps while delivering every one of them on time. It counts only together
 * with frames actually missing (`SLOW_ENCODE_FPS_FRACTION`).
 */
const ENCODE_BUDGET_FRACTION = 0.9;
/** A slow encode and less than this fraction of the target leaving: the encoder is behind. */
const SLOW_ENCODE_FPS_FRACTION = 0.8;
/** The capture is delivering when it hands over at least this fraction of the target. */
const SOURCE_DELIVERING_FRACTION = 0.7;
/** Frames this large (as a fraction of the bitrate target) mean the picture is moving. */
const MOTION_KBPS_FRACTION = 0.4;

/**
 * The verdict for one reading at a target frame rate.
 *
 * A still screen legitimately produces few frames, and the capture only
 * delivers on change, so low frame rate alone proves nothing. It counts when
 * there is evidence the picture is moving: the capture hands frames over and
 * the encoder does not send them, or what does go out is large.
 */
export function judgeShareSample(
  sample: ShareGuardSample,
  targetFps: number,
): ShareGuardJudgement {
  if (sample.limitedBy === "bandwidth") {
    return { verdict: "network", reason: null };
  }
  if (sample.limitedBy === "cpu") {
    return { verdict: "starved-encoder", reason: "cpu-limited" };
  }
  if (sample.fps === null) {
    return { verdict: "unknown", reason: null };
  }
  const budgetMs = 1000 / targetFps;
  if (
    sample.encodeMs !== null &&
    sample.encodeMs > budgetMs * ENCODE_BUDGET_FRACTION &&
    sample.fps < targetFps * SLOW_ENCODE_FPS_FRACTION
  ) {
    return { verdict: "starved-encoder", reason: "encode-time" };
  }
  if (sample.fps < targetFps * LOW_FPS_FRACTION) {
    if (
      sample.sourceFps !== null &&
      sample.sourceFps >= targetFps * SOURCE_DELIVERING_FRACTION
    ) {
      return { verdict: "starved-encoder", reason: "low-fps" };
    }
    if (
      sample.kbps !== null &&
      sample.targetKbps !== null &&
      sample.targetKbps > 0 &&
      sample.kbps >= sample.targetKbps * MOTION_KBPS_FRACTION
    ) {
      return { verdict: "starved-capture", reason: "low-fps" };
    }
  }
  return { verdict: "healthy", reason: null };
}

const SEVERITY: Record<ShareGuardVerdict, number> = {
  "starved-encoder": 4,
  "starved-capture": 3,
  network: 2,
  unknown: 1,
  healthy: 0,
};

/** One share can leave through several senders (a mesh call): the worst one decides. */
export function worstShareSample(
  samples: readonly ShareGuardSample[],
  targetFps: number,
): { sample: ShareGuardSample; judgement: ShareGuardJudgement } | null {
  let worst: { sample: ShareGuardSample; judgement: ShareGuardJudgement } | null =
    null;
  for (const sample of samples) {
    const judgement = judgeShareSample(sample, targetFps);
    if (
      worst === null ||
      SEVERITY[judgement.verdict] > SEVERITY[worst.judgement.verdict]
    ) {
      worst = { sample, judgement };
    }
  }
  return worst;
}

// -------------------------------------------------------------- the machine

export interface ShareGuardConfig {
  /** Sustained starvation before a step down. */
  downAfterMs: number;
  /** ...and at least this many starved readings inside it. */
  minBadSamples: number;
  /** Readings right after a step are not trusted: the encoder is reconfiguring. */
  settleMs: number;
  /** Sustained health before a step up. */
  upAfterMs: number;
  /** The wait for a step up never grows past this. */
  maxUpAfterMs: number;
  /** A step down this soon after a step up counts as a flap. */
  flapWindowMs: number;
  /** After this many flaps the share stays where it is. */
  maxFlaps: number;
  /** Projected encode time at the higher level, as a fraction of what it was when the share was starved. */
  headroomFraction: number;
  /** Sending at least this fraction of the target counts as delivering. */
  deliveringFraction: number;
}

export const DEFAULT_SHARE_GUARD_CONFIG: ShareGuardConfig = {
  downAfterMs: 5_000,
  minBadSamples: 3,
  settleMs: 8_000,
  upAfterMs: 45_000,
  maxUpAfterMs: 600_000,
  flapWindowMs: 90_000,
  maxFlaps: 3,
  headroomFraction: 0.6,
  deliveringFraction: 0.85,
};

export interface ShareGuardDecision {
  action: "down" | "up" | "hold";
  level: ShareGuardLevel;
  verdict: ShareGuardVerdict;
  reason: ShareGuardJudgement["reason"];
}

export interface ShareGuardSnapshot {
  level: ShareGuardLevel;
  steps: number;
  flaps: number;
  sticky: boolean;
  settling: boolean;
}

export interface ShareGuard {
  /** Feed one reading (or several senders' readings, worst decides). */
  observe(samples: readonly ShareGuardSample[]): ShareGuardDecision;
  level(): ShareGuardLevel;
  snapshot(): ShareGuardSnapshot;
  /** Put the guard on a level by hand (a console helper); null returns to the top. */
  force(index: number | null, at: number): ShareGuardLevel;
  /** Start over on a new ladder (the presenter changed the capture rate). */
  rebase(ladder: readonly ShareGuardLevel[]): ShareGuardLevel;
}

export function createShareGuard(
  initialLadder: readonly ShareGuardLevel[],
  config: ShareGuardConfig = DEFAULT_SHARE_GUARD_CONFIG,
): ShareGuard {
  let ladder = initialLadder;
  let index = 0;
  let badSince: number | null = null;
  let badCount = 0;
  let quietRun = 0;
  let healthySince: number | null = null;
  let settleUntil = 0;
  let lastUpAt: number | null = null;
  let flaps = 0;
  let steps = 0;
  let sticky = false;
  let lastAt = 0;
  /** The encode time per frame of the last starved reading that had one. */
  let lastBadEncodeMs: number | null = null;

  function resetStreaks(): void {
    badSince = null;
    badCount = 0;
    quietRun = 0;
    healthySince = null;
  }

  function currentUpAfter(): number {
    return Math.min(config.upAfterMs * 2 ** flaps, config.maxUpAfterMs);
  }

  /**
   * Would the level above be carried? Judged against what the same machine
   * measured when it was starved, never against an absolute number: an
   * asynchronous hardware encoder shows a long encode time while it is
   * healthy, so the only honest comparison is "meaningfully better than when
   * it was failing", scaled by how many more pixels the higher level costs.
   * With nothing measured (no encode times reported) the flap back-off is the
   * only brake, which is what it is for.
   */
  function hasHeadroom(
    sample: ShareGuardSample,
    from: ShareGuardLevel,
    to: ShareGuardLevel,
  ): boolean {
    if (sample.encodeMs === null || lastBadEncodeMs === null) {
      return true;
    }
    const ratio = to.height / from.height;
    const projected = sample.encodeMs * ratio * ratio;
    return projected <= lastBadEncodeMs * config.headroomFraction;
  }

  /**
   * Where a step down goes. An encoder that is behind is helped by fewer
   * pixels first and frames last. A capture that is behind is NOT helped by
   * fewer pixels: the readback costs the same whatever size the frame is
   * scaled to afterwards, and the only thing that lightens it is being asked
   * for fewer frames, so that verdict goes straight to the frame-rate level,
   * and to nothing at all when the capture was already at 30.
   */
  function nextDownIndex(verdict: ShareGuardVerdict): number | null {
    if (verdict === "starved-capture") {
      for (let at = index + 1; at < ladder.length; at += 1) {
        if (ladder[at]!.step === "frame-rate") {
          return at;
        }
      }
      return null;
    }
    return index < ladder.length - 1 ? index + 1 : null;
  }

  function moveTo(next: number, at: number): void {
    index = next;
    steps += 1;
    settleUntil = at + config.settleMs;
    resetStreaks();
  }

  return {
    observe(samples) {
      const current = ladder[index]!;
      const worst = worstShareSample(samples, current.maxFps);
      if (!worst) {
        return { action: "hold", level: current, verdict: "unknown", reason: null };
      }
      const { sample, judgement } = worst;
      const at = sample.at;
      lastAt = at;
      const hold = (): ShareGuardDecision => ({
        action: "hold",
        level: ladder[index]!,
        verdict: judgement.verdict,
        reason: judgement.reason,
      });
      if (at < settleUntil) {
        return hold();
      }
      const starved =
        judgement.verdict === "starved-encoder" ||
        judgement.verdict === "starved-capture";
      if (starved) {
        quietRun = 0;
        healthySince = null;
        if (sample.encodeMs !== null) {
          lastBadEncodeMs = sample.encodeMs;
        }
        if (badSince === null) {
          badSince = at;
          badCount = 0;
        }
        badCount += 1;
        const nextDown = nextDownIndex(judgement.verdict);
        if (
          badCount >= config.minBadSamples &&
          at - badSince >= config.downAfterMs &&
          nextDown !== null
        ) {
          if (lastUpAt !== null && at - lastUpAt <= config.flapWindowMs) {
            flaps += 1;
            if (flaps >= config.maxFlaps) {
              sticky = true;
            }
          }
          lastUpAt = null;
          moveTo(nextDown, at);
          return {
            action: "down",
            level: ladder[index]!,
            verdict: judgement.verdict,
            reason: judgement.reason,
          };
        }
        return hold();
      }
      // A reading the link explains is neither evidence for nor against: a
      // starved machine flips between "bandwidth" and "none" from one reading
      // to the next (feedback that arrives late looks like a slow link), and
      // letting those readings reset the streak kept a lab run that was
      // stalling for 40 s from ever reaching its step. Health needs to
      // be seen; a network reading does not count as seeing it.
      if (judgement.verdict === "network") {
        healthySince = null;
        return hold();
      }
      // Not starved. One good reading does not end a bad streak that a game's
      // frame-time noise can interrupt; two in a row do.
      quietRun += 1;
      if (quietRun >= 2) {
        badSince = null;
        badCount = 0;
      }
      const delivering =
        judgement.verdict === "healthy" &&
        sample.fps !== null &&
        sample.fps >= current.maxFps * config.deliveringFraction;
      const higher = index > 0 ? ladder[index - 1]! : null;
      if (!delivering || higher === null || sticky || !hasHeadroom(sample, current, higher)) {
        healthySince = null;
        return hold();
      }
      if (healthySince === null) {
        healthySince = at;
      }
      if (at - healthySince >= currentUpAfter()) {
        lastUpAt = at;
        moveTo(index - 1, at);
        return {
          action: "up",
          level: ladder[index]!,
          verdict: judgement.verdict,
          reason: null,
        };
      }
      return hold();
    },
    level: () => ladder[index]!,
    snapshot: () => ({
      level: ladder[index]!,
      steps,
      flaps,
      sticky,
      settling: lastAt < settleUntil,
    }),
    force(target, at) {
      const next =
        target === null ? 0 : Math.max(0, Math.min(ladder.length - 1, Math.trunc(target)));
      if (next !== index) {
        moveTo(next, at);
      }
      // A manual step is an experiment, not evidence: it must not teach the
      // machine anything about flapping.
      lastUpAt = null;
      return ladder[index]!;
    },
    rebase(next) {
      ladder = next;
      index = 0;
      steps = 0;
      flaps = 0;
      sticky = false;
      lastUpAt = null;
      lastBadEncodeMs = null;
      settleUntil = 0;
      resetStreaks();
      return ladder[0]!;
    },
  };
}

import type { LiveHlsTelemetrySample } from "@pqp/shared";

/**
 * TELEMETRY V2'S HALF OF THE `voice.hlsTelemetryBatch` LOG LINE (2026-09-23).
 *
 * The 2026-09-21 party could only be read as "33% of 30-second windows had a
 * `waiting`": the attach's own startup counted, no duration was ever sent,
 * and the rebuild number was a lifetime counter, so one rebuilt viewer
 * "rebuilt" in every later window. Clients built after 2026-09-23 tag each
 * sample (startup or steady, frozen milliseconds, window length, rebuilds in
 * THIS window, hole skips, visibility, player mode, fatal details); this
 * folds one batch of them into the fields the log line carries, headed by
 * the number the investigation asked for: frozen seconds per viewer-minute
 * of steady playback.
 *
 * Old clients send none of the new fields and get nothing new here: every
 * aggregate counts only samples that carry the field it reads, and
 * `startup` absent means "unknown", so an old sample is neither steady nor
 * startup and never dilutes the headline.
 */
export interface HlsTelemetryBatchSummary {
  totalRebufferMs: number;
  steadySamples: number;
  startupSamples: number;
  steadyStalls: number;
  steadyRebufferMs: number;
  steadyWindowMs: number;
  /** Frozen seconds per minute of steady playback; undefined with no steady window. */
  stallSecondsPerMinute: number | undefined;
  holeSkips: number;
  rebuilds: number;
  playerModes: string[];
  hiddenSamples: number;
  mutedSamples: number;
  fatal: string[];
  /**
   * Median of the latency the player said it was AIMING for
   * (`targetLatencyMs`, LL only), over the samples that carry it. Beside
   * `medianLatencyMs` it says whether a viewer sits where its governor
   * (`client/src/lib/hls-ll-latency.ts`) put it (8 to 20 s on segments, by
   * design) or has drifted off it. The field was accepted by the schema and
   * then dropped here until 2026-10-18, so an LL batch at 8 to 21 s could
   * not be told from a broken one. Undefined when no sample carries it.
   */
  medianTargetLatencyMs: number | undefined;
  /** Median of (latency minus target), per sample carrying both. Near 0: holding the target. */
  medianLatencyOverTargetMs: number | undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const FATAL_DETAIL = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_FATAL = 8;

export function summarizeHlsTelemetryBatch(
  samples: readonly LiveHlsTelemetrySample[],
): HlsTelemetryBatchSummary {
  let totalRebufferMs = 0;
  let steadySamples = 0;
  let startupSamples = 0;
  let steadyStalls = 0;
  let steadyRebufferMs = 0;
  let steadyWindowMs = 0;
  let holeSkips = 0;
  let rebuilds = 0;
  let hiddenSamples = 0;
  let mutedSamples = 0;
  const targets: number[] = [];
  const overTarget: number[] = [];
  const playerModes = new Set<string>();
  const fatal = new Set<string>();
  for (const sample of samples) {
    totalRebufferMs += sample.rebufferMs ?? 0;
    holeSkips += sample.holeSkips ?? 0;
    rebuilds += sample.rebuilds ?? 0;
    if (sample.hidden) {
      hiddenSamples += 1;
    }
    if (sample.muted) {
      mutedSamples += 1;
    }
    if (sample.targetLatencyMs !== undefined) {
      targets.push(sample.targetLatencyMs);
      overTarget.push(sample.latencyMs - sample.targetLatencyMs);
    }
    if (sample.playerMode) {
      playerModes.add(sample.playerMode);
    }
    for (const detail of sample.fatal ?? []) {
      if (fatal.size < MAX_FATAL && FATAL_DETAIL.test(detail)) {
        fatal.add(detail);
      }
    }
    if (sample.startup === true) {
      startupSamples += 1;
    } else if (sample.startup === false) {
      steadySamples += 1;
      steadyStalls += sample.stalls ?? 0;
      steadyRebufferMs += sample.rebufferMs ?? 0;
      steadyWindowMs += sample.windowMs ?? 0;
    }
  }
  return {
    totalRebufferMs: Math.round(totalRebufferMs),
    steadySamples,
    startupSamples,
    steadyStalls,
    steadyRebufferMs: Math.round(steadyRebufferMs),
    steadyWindowMs,
    stallSecondsPerMinute:
      steadyWindowMs > 0
        ? Math.round(((steadyRebufferMs / 1_000) * 60_000 * 100) / steadyWindowMs) /
          100
        : undefined,
    holeSkips,
    rebuilds,
    playerModes: [...playerModes],
    hiddenSamples,
    mutedSamples,
    fatal: [...fatal],
    medianTargetLatencyMs: median(targets),
    medianLatencyOverTargetMs: median(overTarget),
  };
}

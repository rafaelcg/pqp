import { hlsRungVideoKbps, isKnownHlsRung } from "./hls-ladder.js";

/**
 * In-process aggregation of client-reported watch-party latency
 * (BROADCAST_PIPELINE B0.5/B0.6): a viewer's batch lands here, folded into a
 * per-rung histogram, and `GET /api/admin/metrics` reads the histogram back
 * as p50/p95. Nothing here is durable — a restart clears it, the same as
 * every other in-process counter this file's neighbours already report
 * (`hlsKeepWarmRenders`, `liveHlsActivity`'s counters) — because the number
 * that matters is "how is THIS party doing right now", not a historical
 * record a dashboard needs to survive a deploy.
 *
 * WHY A HISTOGRAM AND NOT THE RAW SAMPLES. A live party can run for hours at
 * a 10% sample rate across hundreds of viewers; keeping every reading would
 * be an unbounded array behind a metrics counter, the exact shape of leak
 * this file's neighbours (`hls-egress.ts`'s per-room maps) go out of their
 * way to avoid. A fixed set of buckets is O(1) memory per rung regardless of
 * how long the party runs or how many viewers report.
 *
 * WHY BUCKETS RATHER THAN A T-DIGEST OR SIMILAR. The buckets below are wide
 * enough that "which bucket" is already close to the precision `latencyMs`
 * itself carries once client clock skew and the deliberate over-estimate
 * from a synthesised PDT (`hls-live-window.ts`) are accounted for. A percentile
 * library is more precision than this number is honest about.
 */

/**
 * Upper bound of each bucket, milliseconds. Finer near the numbers a normal
 * party sits at (the ~20s cushion `hls-watch-player.tsx` targets, see
 * CLAUDE.md pitfall list and `docs/plans/BROADCAST_PIPELINE.md`), coarser
 * above it: past a minute the exact number matters less than "very late".
 */
export const HLS_LATENCY_BUCKET_BOUNDARIES_MS = [
  1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 8_000, 10_000, 12_000, 15_000,
  20_000, 25_000, 30_000, 45_000, 60_000,
];

interface RungHistogram {
  /** Parallel to `HLS_LATENCY_BUCKET_BOUNDARIES_MS`: counts[i] is samples
   * with `latencyMs` in `(boundaries[i-1], boundaries[i]]`. */
  counts: number[];
  /** Samples above the last (60s) boundary. */
  overflow: number;
  count: number;
}

const histograms = new Map<string, RungHistogram>();

/** Batches this process has accepted, folded into the histograms above. */
let batchesAccepted = 0;
/** Batches refused for failing schema validation. */
let batchesRejectedSchema = 0;
/** Batches refused by the per-user rate limit. */
let batchesRejectedRateLimit = 0;
/**
 * Batches refused for carrying a `sessionToken` that does not verify (bad
 * signature, expired, or naming a user other than the authenticated caller).
 * Distinct from a batch simply omitting the token (the `LIVE_HLS_SIGNED_URLS
 * =false` configuration mints none, and that batch is accepted on its
 * `sessionId` alone): this counts a token that was PRESENT and WRONG, which
 * is the shape an attacker trying to claim a session it does not hold would
 * produce. Pitfall 16's lesson: an endpoint that refuses somebody must say
 * why, so this stays a distinct counter from schema/rate-limit rejections
 * rather than folding into either.
 */
let batchesRejectedSession = 0;
/** Individual samples folded into a histogram, across every accepted batch. */
let samplesRecorded = 0;
/**
 * Samples refused for naming a rung this build does not recognise (Farol
 * finding, 2026-09-13): `POST /api/live-hls/telemetry`'s `rung` field is a
 * free-form 1-16 character string the caller controls, and every accepted
 * value would otherwise become its OWN permanent key in the map below --
 * one authenticated account sending distinct garbage rungs grows it without
 * bound for the life of the process. Enforced here, not just at the route,
 * so this module is safe to call from anywhere the same way.
 */
let samplesRejectedUnknownRung = 0;

function histogramFor(rung: string): RungHistogram {
  let histogram = histograms.get(rung);
  if (!histogram) {
    histogram = {
      counts: HLS_LATENCY_BUCKET_BOUNDARIES_MS.map(() => 0),
      overflow: 0,
      count: 0,
    };
    histograms.set(rung, histogram);
  }
  return histogram;
}

/**
 * Fold one sample into its rung's histogram. A no-op, counted separately,
 * when `rung` is not one of `LADDER_RUNGS`/`CAMERA_RUNG_NAME`: see
 * `samplesRejectedUnknownRung` above.
 */
export function recordHlsLatencySample(rung: string, latencyMs: number): void {
  if (!isKnownHlsRung(rung)) {
    samplesRejectedUnknownRung += 1;
    return;
  }
  const histogram = histogramFor(rung);
  histogram.count += 1;
  samplesRecorded += 1;
  const bucketIndex = HLS_LATENCY_BUCKET_BOUNDARIES_MS.findIndex(
    (boundary) => latencyMs <= boundary,
  );
  if (bucketIndex === -1) {
    histogram.overflow += 1;
  } else {
    histogram.counts[bucketIndex] += 1;
  }
}

/** Record one accepted batch (for the operational counters, not the histogram). */
export function recordHlsTelemetryBatchAccepted(): void {
  batchesAccepted += 1;
}

/** Record one batch refused for failing schema validation. */
export function recordHlsTelemetryBatchRejectedSchema(): void {
  batchesRejectedSchema += 1;
}

/** Record one batch refused by the per-user or per-session rate limit. */
export function recordHlsTelemetryBatchRejectedRateLimit(): void {
  batchesRejectedRateLimit += 1;
}

/** Record one batch refused for carrying a `sessionToken` that does not verify. */
export function recordHlsTelemetryBatchRejectedSession(): void {
  batchesRejectedSession += 1;
}

/**
 * The bucket boundary at or above which `fraction` of this rung's samples
 * fall — an approximation bounded by bucket width, never worse than the gap
 * between two adjacent boundaries. Null when the rung has no samples yet.
 */
function percentile(histogram: RungHistogram, fraction: number): number | null {
  if (histogram.count === 0) {
    return null;
  }
  const target = Math.ceil(histogram.count * fraction);
  let cumulative = 0;
  for (let i = 0; i < histogram.counts.length; i++) {
    cumulative += histogram.counts[i]!;
    if (cumulative >= target) {
      return HLS_LATENCY_BUCKET_BOUNDARIES_MS[i]!;
    }
  }
  // Still short of `target`: the remainder is in the overflow bucket, which
  // has no upper edge to report. The last real boundary is a floor -- "at
  // least this late" -- which is the honest thing to show rather than
  // inventing a ceiling.
  return HLS_LATENCY_BUCKET_BOUNDARIES_MS[
    HLS_LATENCY_BUCKET_BOUNDARIES_MS.length - 1
  ]!;
}

export interface HlsLatencyRungSummary {
  rung: string;
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/**
 * Per-rung p50/p95, lowest bitrate first (the actual `videoKbps` a rung
 * encodes at, not `localeCompare` on its name -- alphabetically `1080p30`
 * sorts before `720p30`, which is backwards). A rung this build no longer
 * recognises (an operator's ladder changed since the histogram was warmed)
 * sorts last rather than throwing.
 */
export function hlsLatencySnapshot(): HlsLatencyRungSummary[] {
  return [...histograms.entries()]
    .map(([rung, histogram]) => ({
      rung,
      count: histogram.count,
      p50Ms: percentile(histogram, 0.5),
      p95Ms: percentile(histogram, 0.95),
    }))
    .sort((a, b) => {
      const kbpsA = hlsRungVideoKbps(a.rung) ?? Number.MAX_SAFE_INTEGER;
      const kbpsB = hlsRungVideoKbps(b.rung) ?? Number.MAX_SAFE_INTEGER;
      return kbpsA !== kbpsB ? kbpsA - kbpsB : a.rung.localeCompare(b.rung);
    });
}

export interface HlsTelemetryActivity {
  batchesAccepted: number;
  batchesRejectedSchema: number;
  batchesRejectedRateLimit: number;
  batchesRejectedSession: number;
  samplesRecorded: number;
  samplesRejectedUnknownRung: number;
  byRung: HlsLatencyRungSummary[];
}

/** Everything `GET /api/admin/metrics`'s `liveHls.latency` block reads. */
export function hlsTelemetryActivity(): HlsTelemetryActivity {
  return {
    batchesAccepted,
    batchesRejectedSchema,
    batchesRejectedRateLimit,
    batchesRejectedSession,
    samplesRecorded,
    samplesRejectedUnknownRung,
    byRung: hlsLatencySnapshot(),
  };
}

export function resetHlsLatencyMetricsForTests(): void {
  histograms.clear();
  batchesAccepted = 0;
  batchesRejectedSchema = 0;
  batchesRejectedRateLimit = 0;
  batchesRejectedSession = 0;
  samplesRecorded = 0;
  samplesRejectedUnknownRung = 0;
}

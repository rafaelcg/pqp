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
/** Individual samples folded into a histogram, across every accepted batch. */
let samplesRecorded = 0;

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

/** Fold one sample into its rung's histogram. */
export function recordHlsLatencySample(rung: string, latencyMs: number): void {
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

/** Record one batch refused by the per-user rate limit. */
export function recordHlsTelemetryBatchRejectedRateLimit(): void {
  batchesRejectedRateLimit += 1;
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

/** Per-rung p50/p95, lowest bitrate first by name for a stable panel order. */
export function hlsLatencySnapshot(): HlsLatencyRungSummary[] {
  return [...histograms.entries()]
    .map(([rung, histogram]) => ({
      rung,
      count: histogram.count,
      p50Ms: percentile(histogram, 0.5),
      p95Ms: percentile(histogram, 0.95),
    }))
    .sort((a, b) => a.rung.localeCompare(b.rung));
}

export interface HlsTelemetryActivity {
  batchesAccepted: number;
  batchesRejectedSchema: number;
  batchesRejectedRateLimit: number;
  samplesRecorded: number;
  byRung: HlsLatencyRungSummary[];
}

/** Everything `GET /api/admin/metrics`'s `liveHls.latency` block reads. */
export function hlsTelemetryActivity(): HlsTelemetryActivity {
  return {
    batchesAccepted,
    batchesRejectedSchema,
    batchesRejectedRateLimit,
    samplesRecorded,
    byRung: hlsLatencySnapshot(),
  };
}

export function resetHlsLatencyMetricsForTests(): void {
  histograms.clear();
  batchesAccepted = 0;
  batchesRejectedSchema = 0;
  batchesRejectedRateLimit = 0;
  samplesRecorded = 0;
}

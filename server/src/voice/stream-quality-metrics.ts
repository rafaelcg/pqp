import type {
  StreamQualityLimitationReason,
  StreamQualityRole,
  StreamQualityTelemetrySample,
} from "@pqp/shared";
import type { VoiceRoomTransport } from "@pqp/shared";

/**
 * `streamQuality.*` on `GET /api/admin/metrics`: in-process, bounded
 * histograms of screen-share / watch-party video quality, folded from the
 * client-reported samples `POST /api/stream-quality/telemetry` accepts.
 *
 * WHY BUCKETS AND NOT THE RAW READINGS. A live room can report for hours
 * across dozens of seated participants; keeping every reading would be an
 * unbounded array behind a metrics counter -- the same leak shape
 * `hls-latency-metrics.ts`'s own doc comment warns against. A small, fixed
 * set of buckets per (role, transport) pair is O(1) memory regardless of how
 * long a share runs or how many people are in the room, and the buckets are
 * wide enough that "which bucket" already carries the precision a sampled,
 * client-measured reading is honest about.
 *
 * CARDINALITY. role (2) x transport (2) x bucket (<=7) for each of fps,
 * bitrate and resolution; transport (2) x reason (4) for the limitation
 * reason, which is a presenter-only signal (a receiver's `getStats()` row
 * has no `qualityLimitationReason` -- there is nothing on that side that can
 * make the picture bigger, see `voice-stats-probe.ts`). Every key is a
 * closed enum, never a user id, channel id or anything unbounded, and every
 * snapshot pre-seeds every key to zero, matching `call-metrics.ts` and
 * `push-metrics.ts`'s own convention on this endpoint.
 */

const ROLES: readonly StreamQualityRole[] = ["presenter", "viewer"];
const TRANSPORTS: readonly VoiceRoomTransport[] = ["mesh", "livekit"];
const LIMITATION_REASONS: readonly StreamQualityLimitationReason[] = [
  "none",
  "cpu",
  "bandwidth",
  "other",
];

/**
 * Upper bound of each fps bucket (frames per second). Finer in the low range
 * where a choppy share actually sits -- the "5-6 fps" complaint this feature
 * exists to turn into a number lands squarely in `5-9` rather than being
 * smeared across a wide "low" bucket -- coarser above 30fps, where screen
 * shares rarely target more anyway.
 */
export const FPS_BUCKETS = [
  "0-4",
  "5-9",
  "10-14",
  "15-19",
  "20-24",
  "25-29",
  "30-plus",
] as const;
export type FpsBucket = (typeof FPS_BUCKETS)[number];

export function classifyFps(fps: number): FpsBucket {
  if (fps < 5) return "0-4";
  if (fps < 10) return "5-9";
  if (fps < 15) return "10-14";
  if (fps < 20) return "15-19";
  if (fps < 25) return "20-24";
  if (fps < 30) return "25-29";
  return "30-plus";
}

/** Upper bound of each bitrate bucket, kbps. */
export const BITRATE_BUCKETS = [
  "0-199",
  "200-499",
  "500-999",
  "1000-1999",
  "2000-3999",
  "4000-plus",
] as const;
export type BitrateBucket = (typeof BITRATE_BUCKETS)[number];

export function classifyBitrateKbps(kbps: number): BitrateBucket {
  if (kbps < 200) return "0-199";
  if (kbps < 500) return "200-499";
  if (kbps < 1_000) return "500-999";
  if (kbps < 2_000) return "1000-1999";
  if (kbps < 4_000) return "2000-3999";
  return "4000-plus";
}

/** Classified off the reported frame HEIGHT, which is orientation-stable for
 *  a screen share (unlike width, which flips for a portrait capture). */
export const RESOLUTION_BUCKETS = [
  "240p-minus",
  "360p",
  "480p",
  "720p",
  "1080p",
  "1440p-plus",
] as const;
export type ResolutionBucket = (typeof RESOLUTION_BUCKETS)[number];

export function classifyResolution(height: number): ResolutionBucket {
  if (height <= 240) return "240p-minus";
  if (height <= 360) return "360p";
  if (height <= 480) return "480p";
  if (height <= 720) return "720p";
  if (height <= 1_080) return "1080p";
  return "1440p-plus";
}

type Dimension = "fps" | "bitrate" | "resolution";
const BUCKET_SETS: Record<Dimension, readonly string[]> = {
  fps: FPS_BUCKETS,
  bitrate: BITRATE_BUCKETS,
  resolution: RESOLUTION_BUCKETS,
};

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const counts: Record<Dimension, Map<string, number>> = {
  fps: new Map(),
  bitrate: new Map(),
  resolution: new Map(),
};
const limitationReasonCounts = new Map<string, number>();

let samplesAccepted = 0;
let batchesAccepted = 0;
/** A batch that failed schema validation -- see `stream-quality-telemetry.ts`
 *  in `@pqp/shared`: every field is a closed enum or a bounded number, so
 *  this is the only rejection shape this route has, unlike the HLS latency
 *  route's extra per-sample "unknown rung" guard. */
let batchesRejectedSchema = 0;
let batchesRejectedRateLimit = 0;

function bucketKey(role: StreamQualityRole, transport: VoiceRoomTransport, bucket: string): string {
  return `${role}:${transport}:${bucket}`;
}

/** Fold one accepted sample into the bounded histograms. Never throws --
 *  every field on `StreamQualityTelemetrySample` is already schema-valid by
 *  the time it reaches here. */
export function recordStreamQualitySample(sample: StreamQualityTelemetrySample): void {
  samplesAccepted += 1;
  const { role, transport } = sample;
  if (sample.fps !== undefined) {
    bump(counts.fps, bucketKey(role, transport, classifyFps(sample.fps)));
  }
  if (sample.kbps !== undefined) {
    bump(counts.bitrate, bucketKey(role, transport, classifyBitrateKbps(sample.kbps)));
  }
  if (sample.height !== undefined) {
    bump(counts.resolution, bucketKey(role, transport, classifyResolution(sample.height)));
  }
  // Presenter-only signal: a viewer sample naming one is dropped rather than
  // the whole batch refused (see the schema's own doc comment) -- the field
  // is still legal on the wire, just meaningless on that side.
  if (sample.qualityLimitationReason !== undefined && role === "presenter") {
    bump(limitationReasonCounts, `${transport}:${sample.qualityLimitationReason}`);
  }
}

export function recordStreamQualityBatchAccepted(): void {
  batchesAccepted += 1;
}
export function recordStreamQualityBatchRejectedSchema(): void {
  batchesRejectedSchema += 1;
}
export function recordStreamQualityBatchRejectedRateLimit(): void {
  batchesRejectedRateLimit += 1;
}

function seedDimension(dimension: Dimension): Record<StreamQualityRole, Record<VoiceRoomTransport, Record<string, number>>> {
  const map = counts[dimension];
  const buckets = BUCKET_SETS[dimension];
  const out = {} as Record<StreamQualityRole, Record<VoiceRoomTransport, Record<string, number>>>;
  for (const role of ROLES) {
    const byTransport = {} as Record<VoiceRoomTransport, Record<string, number>>;
    for (const transport of TRANSPORTS) {
      const byBucket: Record<string, number> = {};
      for (const bucket of buckets) {
        byBucket[bucket] = map.get(bucketKey(role, transport, bucket)) ?? 0;
      }
      byTransport[transport] = byBucket;
    }
    out[role] = byTransport;
  }
  return out;
}

export interface StreamQualityMetrics {
  samplesAccepted: number;
  batchesAccepted: number;
  batchesRejectedSchema: number;
  batchesRejectedRateLimit: number;
  fpsBuckets: Record<StreamQualityRole, Record<VoiceRoomTransport, Record<FpsBucket, number>>>;
  bitrateBuckets: Record<
    StreamQualityRole,
    Record<VoiceRoomTransport, Record<BitrateBucket, number>>
  >;
  resolutionBuckets: Record<
    StreamQualityRole,
    Record<VoiceRoomTransport, Record<ResolutionBucket, number>>
  >;
  /** Presenter-only: why the encoder is not sending more, WebRTC's own
   *  `qualityLimitationReason`. This is the number that tells `bandwidth`
   *  (starved uplink) apart from `cpu` (encoder/machine overloaded). */
  limitationReasons: Record<VoiceRoomTransport, Record<StreamQualityLimitationReason, number>>;
}

/** Everything `GET /api/admin/metrics`'s `streamQuality` block reads. */
export function streamQualityMetricsSnapshot(): StreamQualityMetrics {
  const byTransportReason = {} as Record<
    VoiceRoomTransport,
    Record<StreamQualityLimitationReason, number>
  >;
  for (const transport of TRANSPORTS) {
    const byReason = {} as Record<StreamQualityLimitationReason, number>;
    for (const reason of LIMITATION_REASONS) {
      byReason[reason] = limitationReasonCounts.get(`${transport}:${reason}`) ?? 0;
    }
    byTransportReason[transport] = byReason;
  }
  return {
    samplesAccepted,
    batchesAccepted,
    batchesRejectedSchema,
    batchesRejectedRateLimit,
    fpsBuckets: seedDimension("fps") as StreamQualityMetrics["fpsBuckets"],
    bitrateBuckets: seedDimension("bitrate") as StreamQualityMetrics["bitrateBuckets"],
    resolutionBuckets: seedDimension("resolution") as StreamQualityMetrics["resolutionBuckets"],
    limitationReasons: byTransportReason,
  };
}

/** Test seam: forget every count. */
export function resetStreamQualityMetricsForTests(): void {
  counts.fps.clear();
  counts.bitrate.clear();
  counts.resolution.clear();
  limitationReasonCounts.clear();
  samplesAccepted = 0;
  batchesAccepted = 0;
  batchesRejectedSchema = 0;
  batchesRejectedRateLimit = 0;
}

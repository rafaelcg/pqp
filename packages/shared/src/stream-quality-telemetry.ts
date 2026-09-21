import { z } from "zod";
import { voiceRoomTransportSchema } from "./signaling.js";

/**
 * Client-reported screen-share / watch-party video quality: fps, bitrate,
 * resolution, and (presenter side only) WebRTC's own
 * `qualityLimitationReason` -- the field that says WHETHER a choppy share is
 * starved for bandwidth or held back by the encoder/CPU, which a raw fps
 * number alone cannot tell apart.
 *
 * WHY THIS EXISTS. "Screen shares run at 5-6 fps" has been a user report with
 * no number behind it: `RTCPeerConnection.getStats()` is per-connection and
 * per-browser, so the machine that can see the choppy encode is the one
 * having the bad time, and nothing carried what it saw back to the team.
 *
 * SCOPE, DELIBERATELY NARROW. This is WebRTC `getStats()` only -- a presenter
 * always publishes over WebRTC (mesh or LiveKit) regardless of audience size,
 * and so does anyone actually SEATED in that room. A watch party's HLS
 * audience is not: `docs/WATCH_PARTY.md` is explicit that "an audience
 * watches without a seat", so those viewers hold no `RTCPeerConnection` at
 * all and this schema says nothing about them. Their playback quality
 * (encode-to-paint latency, stalls, rebuffering) is already measured by
 * `live-hls-telemetry.ts` / `hls-latency-metrics.ts` on a completely separate
 * sink -- this file is the complementary half nothing captured before: the
 * PRESENTER's encode, and the WebRTC VIEWER's decode, for everyone who is
 * actually in the room.
 *
 * BOUNDED BY CONSTRUCTION. Every field is either a small closed enum or a
 * number clamped to a sane ceiling -- there is no free-text label anywhere
 * on this schema (no channel id, no session id, no rung name), so there is
 * no per-caller unbounded key space for the server's histograms to defend
 * against the way `hls-latency-metrics.ts`'s `rung` allowlist has to. A
 * batch either validates whole or is refused whole.
 */

/** WebRTC's own enum (`RTCQualityLimitationReason`), unmodified. Presenter
 *  (sender) side only -- a receiver has nothing that can make a picture
 *  bigger, so `getStats()` reports no such field on that side. */
export const streamQualityLimitationReasonSchema = z.enum([
  "none",
  "cpu",
  "bandwidth",
  "other",
]);
export type StreamQualityLimitationReason = z.infer<
  typeof streamQualityLimitationReasonSchema
>;

/** Which side of the share this reading is about. */
export const streamQualityRoleSchema = z.enum(["presenter", "viewer"]);
export type StreamQualityRole = z.infer<typeof streamQualityRoleSchema>;

/** How often a sampler ticks while a share is actually live. 15-30s per the
 *  task's own cost bound; picked in the middle. */
export const STREAM_QUALITY_TELEMETRY_SAMPLE_INTERVAL_MS = 20_000;

/**
 * One in this many VIEWERS is sampled at all -- the presenter is never
 * subject to this (there is at most one or two per room, and the presenter's
 * `qualityLimitationReason` is the whole point of this feature). Viewers are
 * everyone else seated in the room with an inbound video row, which in a
 * large LiveKit voice channel with a screen share running can be every
 * listener in it -- see this file's own doc comment on scope. 1-in-5 keeps a
 * beacon flowing from a comfortable sample even for a small room while
 * bounding the worst case for a large one.
 */
export const STREAM_QUALITY_TELEMETRY_VIEWER_SAMPLE_RATE = 0.2;

/** A batch bigger than this is a bug, not a sampler: refused outright. At
 *  most one sample per role is produced per tick today, so this is generous
 *  headroom, not a number anything normal approaches. */
export const STREAM_QUALITY_TELEMETRY_MAX_BATCH = 8;

export const streamQualityTelemetrySampleSchema = z.object({
  role: streamQualityRoleSchema,
  transport: voiceRoomTransportSchema,
  /** `framesPerSecond` off the sender/receiver row, as reported -- already
   *  an instantaneous reading, not something the client differences. */
  fps: z.number().finite().nonnegative().max(1_000).optional(),
  /** Bitrate in kbps, computed client-side from the byte delta since the
   *  sampler's previous reading (never a lifetime average). */
  kbps: z.number().finite().nonnegative().max(500_000).optional(),
  width: z.number().int().positive().max(16_384).optional(),
  height: z.number().int().positive().max(16_384).optional(),
  /** Presenter (sender) side only; a batch that sets this on a `viewer`
   *  sample has it dropped server-side rather than the whole batch refused. */
  qualityLimitationReason: streamQualityLimitationReasonSchema.optional(),
});
export type StreamQualityTelemetrySample = z.infer<
  typeof streamQualityTelemetrySampleSchema
>;

export const streamQualityTelemetryBatchSchema = z.object({
  samples: z
    .array(streamQualityTelemetrySampleSchema)
    .min(1)
    .max(STREAM_QUALITY_TELEMETRY_MAX_BATCH),
});
export type StreamQualityTelemetryBatch = z.infer<
  typeof streamQualityTelemetryBatchSchema
>;

/**
 * A stable 32-bit hash, mirroring `live-hls-telemetry.ts`'s own -- kept as a
 * separate copy rather than a shared export because the two are salted
 * differently on purpose (a user sampled for HLS latency and a user sampled
 * for stream quality are independent coin flips, not the same one reused).
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Whether this VIEWER is one of the sampled ones, deterministic on user id:
 * the same person on two tabs, or reloading mid-call, always lands on the
 * same side of the line, so "one in five viewers" means one in five distinct
 * people rather than one person's tab re-rolling the die until it gets
 * lucky. Never applied to the presenter, who is always included.
 */
export function isSampledForStreamQualityTelemetry(
  userId: string,
  rate: number = STREAM_QUALITY_TELEMETRY_VIEWER_SAMPLE_RATE,
): boolean {
  if (rate <= 0) {
    return false;
  }
  if (rate >= 1) {
    return true;
  }
  const fraction = fnv1a(`stream-quality-telemetry:${userId}`) / 0xffffffff;
  return fraction < rate;
}

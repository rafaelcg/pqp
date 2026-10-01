import { z } from "zod";
import { safeTextSchema } from "./api.js";

/**
 * How a call went, in one number, asked once after it ends.
 *
 * WHY THIS EXISTS SEPARATELY FROM `feedback`. Feedback is written by somebody
 * who decided to go and complain, which selects hard for the people already
 * annoyed enough to open settings. A call rating is asked, not volunteered, so
 * it is the only signal here that a quiet majority ever produces. They answer
 * different questions and must not share a table: mixing an unprompted essay
 * with a prompted 1-to-5 would make the average meaningless and the queue
 * unreadable.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY. No message content, no peer identities,
 * no IP, no channel name. The row is a score, a shape of call, and a
 * timestamp. `channelId` is here because "one room is always bad" is the most
 * actionable thing this can possibly tell an operator, and it is an opaque id
 * that says nothing about who was in it.
 */
export const CALL_RATING_MIN = 1;
export const CALL_RATING_MAX = 5;

/** Longer than this and it wants to be feedback, which has its own box. */
export const CALL_RATING_NOTE_MAX_LENGTH = 280;

/**
 * Which media path carried the call. Recorded because the whole point of
 * having both is knowing whether the SFU is actually better, and an average
 * that mixes them cannot answer that.
 */
export const CALL_TRANSPORTS = ["mesh", "livekit"] as const;
export type CallTransport = (typeof CALL_TRANSPORTS)[number];

/**
 * A screen share's shape during the call, from one side of the wire.
 *
 * MEDIAN AND P10 RATHER THAN AN AVERAGE, and rather than the raw samples.
 * "Screen share was bad" has to be traceable to one of two very different
 * stories -- a share that ran fine and stumbled for ten seconds, and a share
 * that never got out of the mud -- and an average collapses both into the
 * same number. The median says how it usually looked; the tenth percentile
 * says how bad the bad moments got. Neither is the raw sample list, which
 * would make this schema unbounded and would carry nothing an operator can
 * act on that the two percentiles do not already say.
 *
 * OUTBOUND AND INBOUND CARRY DIFFERENT FIELDS ON PURPOSE, mirroring
 * `VideoSenderSample` / `VideoReceiverSample` in `voice-stats-probe.ts`: a
 * sender knows why it held back (`qualityLimitationReason`, split into
 * seconds of each cause), and a receiver knows how the result actually
 * looked (freezes, dropped frames). Neither side can honestly report the
 * other's field, so this is two schemas rather than one with everything
 * optional.
 */
const frameRateFieldSchema = z.number().finite().nonnegative().max(240);
const frameHeightFieldSchema = z.number().int().nonnegative().max(8640);
/** Seconds, bounded the same way `durationSeconds` is: a call is a day at
 *  most, and clamping beats refusing the whole rating over a clock skew. */
const secondsFieldSchema = z.number().finite().nonnegative().max(86_400);

export const outboundStreamQualitySchema = z
  .object({
    frameRateMedian: frameRateFieldSchema.nullable(),
    frameRateP10: frameRateFieldSchema.nullable(),
    frameHeightMedian: frameHeightFieldSchema.nullable(),
    frameHeightP10: frameHeightFieldSchema.nullable(),
    /** Seconds of the call this sender spent `qualityLimitationReason:
     *  "bandwidth"`, read straight off `getStats()`'s own cumulative field. */
    bandwidthLimitedSeconds: secondsFieldSchema.nullable(),
    /** Same, for `"cpu"`. The two are opposite fixes, which is the entire
     *  reason `describeLimitation` in `voice-stats-probe.ts` exists, and the
     *  entire reason this is two fields rather than one. */
    cpuLimitedSeconds: secondsFieldSchema.nullable(),
  })
  .strict();
export type OutboundStreamQuality = z.infer<typeof outboundStreamQualitySchema>;

export const inboundStreamQualitySchema = z
  .object({
    frameRateMedian: frameRateFieldSchema.nullable(),
    frameRateP10: frameRateFieldSchema.nullable(),
    frameHeightMedian: frameHeightFieldSchema.nullable(),
    frameHeightP10: frameHeightFieldSchema.nullable(),
    /** Lifetime `freezeCount` off the inbound track, the receiver's own
     *  quality complaint. */
    freezeCount: z.number().int().nonnegative().max(100_000).nullable(),
    /** `totalFreezesDuration`, same spelling as the WebRTC stat it reads. */
    freezeSeconds: secondsFieldSchema.nullable(),
    /** Frames the jitter buffer had but never rendered -- distinct from a
     *  freeze, which is the picture visibly stopping. */
    framesDropped: z.number().int().nonnegative().max(10_000_000).nullable(),
  })
  .strict();
export type InboundStreamQuality = z.infer<typeof inboundStreamQualitySchema>;

/**
 * What actually happened to the media during a call, bounded by construction:
 * no peer id, no ip, no free text -- only closed-shape numbers and one
 * boolean, same discipline as `stream-quality-telemetry.ts`. Collected on the
 * client from the exact sampler the quality readouts already poll
 * (`sampleVoiceStats()`), so it can never disagree with what a person saw on
 * screen while the call was live.
 *
 * `outboundScreenShare` is this machine's own share, when it made one.
 * `inboundScreenShare` is whichever peer's share this machine watched the
 * most during the call, not every share it briefly saw -- a five-way
 * conversation where three people flashed a window for a second each would
 * otherwise average away the one share that was actually being watched.
 */
export const mediaQualitySchema = z
  .object({
    outboundScreenShare: outboundStreamQualitySchema.nullable(),
    inboundScreenShare: inboundStreamQualitySchema.nullable(),
    /** Percent, over the whole call, from the same windowed loss counters the
     *  three-bar link meter already reads. */
    packetLossPercent: z.number().finite().min(0).max(100).nullable(),
    /** Milliseconds. Bounded loosely -- a satellite link is still a real
     *  reading, and clamping RTT hides the exact case this exists to find. */
    rttMsMedian: z.number().finite().nonnegative().max(30_000).nullable(),
    /** True when the selected ICE candidate pair was a TURN relay on either
     *  end for most of the call; false for a direct path; null when nothing
     *  was ever sampled (audio-only calls still sample paths, so this is only
     *  null when the call ended before a first sample landed). */
    relayed: z.boolean().nullable(),
    /** How many times a peer this machine had already reached went down and
     *  came back during the call. Zero, not null, when nothing ever did --
     *  the absence of a reconnect is itself the answer. */
    reconnectCount: z.number().int().nonnegative().max(1_000),
  })
  .strict();
export type MediaQualitySummary = z.infer<typeof mediaQualitySchema>;

export const createCallRatingSchema = z.object({
  rating: z.number().int().min(CALL_RATING_MIN).max(CALL_RATING_MAX),
  /**
   * Only ever collected on a low score, where the number alone does not say
   * what broke. Optional everywhere so a client that does not ask still
   * validates.
   */
  note: z
    .string()
    .trim()
    .min(1)
    .max(CALL_RATING_NOTE_MAX_LENGTH)
    .pipe(safeTextSchema)
    .optional(),
  /**
   * Clamped rather than merely validated: a clock change or a tab left open
   * over a weekend should not be able to write a nonsense duration, and
   * refusing the whole rating over it would lose the score, which is the part
   * that matters.
   */
  durationSeconds: z.number().int().min(0).max(86_400),
  /** How many other people were in the room at the end. */
  peerCount: z.number().int().min(0).max(100),
  transport: z.enum(CALL_TRANSPORTS),
  /** Whether a screen was being shared, which is the feature most likely to be what they are rating. */
  hadScreenShare: z.boolean(),
  channelId: z.string().uuid().optional(),
  /**
   * Absent on a build that does not collect it yet, and absent whenever the
   * call had no video sender or receiver to sample in the first place --
   * neither means the client is lying, so this is optional rather than a
   * required field defaulted to nulls.
   */
  mediaQuality: mediaQualitySchema.optional(),
});
export type CreateCallRatingRequest = z.infer<typeof createCallRatingSchema>;

/**
 * What the operator dashboard shows. Counts, not rows: an individual score is
 * noise, and exposing them one by one would slowly rebuild a per-person record
 * of who has bad wifi.
 */
export const callRatingSummarySchema = z.object({
  /** Ratings in the window. */
  total: z.number(),
  /** Mean, to one decimal, or null when nobody has rated anything yet. */
  average: z.number().nullable(),
  /** How many of each score, indexed 1 to 5. */
  distribution: z.record(z.string(), z.number()),
  /** Mean per transport, so mesh and the SFU can be compared honestly. */
  byTransport: z.array(
    z.object({
      transport: z.enum(CALL_TRANSPORTS),
      total: z.number(),
      average: z.number().nullable(),
    }),
  ),
  /**
   * The newest few notes, which only exist on low scores -- and, precisely
   * because they only exist on low scores, the one place a low rating's own
   * media quality reading belongs. Null when the rating carried none (an
   * older client, or a call with nothing to sample).
   */
  recentNotes: z.array(
    z.object({
      rating: z.number(),
      note: z.string(),
      createdAt: z.string(),
      mediaQuality: mediaQualitySchema.nullable().optional(),
    }),
  ),
});
export type CallRatingSummary = z.infer<typeof callRatingSummarySchema>;

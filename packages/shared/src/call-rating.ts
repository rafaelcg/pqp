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
  /** The newest few notes, which only exist on low scores. */
  recentNotes: z.array(
    z.object({
      rating: z.number(),
      note: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type CallRatingSummary = z.infer<typeof callRatingSummarySchema>;

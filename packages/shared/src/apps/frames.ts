import { z } from "zod";
import {
  appEndReasonSchema,
  appResultSchema,
  appParticipantConnectionSchema,
  appRoleSchema,
  appUserIdSchema,
  eventDataSchema,
  eventNameSchema,
  seatIdSchema,
  stateRevSchema,
  statePatchSchema,
  stateSnapshotSchema,
  stateValueSchema,
} from "./common.js";
import { APP_MAX_PARTICIPANTS } from "./limits.js";

/**
 * WebSocket frames for apps, between the pqp client and the API over `/ws`.
 *
 * These are pqp-internal. They may carry pqp user ids (the page needs them to
 * draw avatars and the presence line), and the page strips every one before
 * anything reaches the sandboxed app (see `bridge.ts`, which has no user id).
 *
 * `chat.ts` lists them in `chatClientMessageSchema` / `chatServerMessageSchema`
 * as the session engine ships: `channel-app` and `app-ended` first, the join,
 * state and event frames with the socket handlers after. A frame not listed
 * there yet is only a contract and nothing sends it.
 *
 * Strict toward the less trusted side, tolerant toward a newer peer: client to
 * server frames are strict (an unknown key is a rejection, the server validates
 * untrusted input), server to client frames use zod's default strip (an unknown
 * key is dropped, never passed through), so a field added to a server frame
 * later does not make an older client reject the whole frame.
 */

const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Client to server

export const appJoinSchema = z
  .object({
    type: z.literal("app-join"),
    sessionId: uuid,
    asSpectator: z.boolean().optional(),
  })
  .strict();

export const appLeaveSchema = z
  .object({ type: z.literal("app-leave"), sessionId: uuid })
  .strict();

export const appStatePatchSchema = z
  .object({
    type: z.literal("app-state-patch"),
    sessionId: uuid,
    baseRev: stateRevSchema.optional(),
    /** JSON Merge Patch (RFC 7396), at most `APP_STATE_MAX_BYTES` serialized. */
    patch: statePatchSchema,
  })
  .strict();

export const appEventSendSchema = z
  .object({
    type: z.literal("app-event-send"),
    sessionId: uuid,
    name: eventNameSchema,
    /** At most `APP_EVENT_MAX_BYTES` serialized. */
    data: eventDataSchema,
  })
  .strict();

export const appClientFrameSchema = z.discriminatedUnion("type", [
  appJoinSchema,
  appLeaveSchema,
  appStatePatchSchema,
  appEventSendSchema,
]);
export type AppClientFrame = z.infer<typeof appClientFrameSchema>;

// ---------------------------------------------------------------------------
// Server to client

/** One person in a session, as the whole channel's viewers may see it. */
export const appSessionSummaryParticipantSchema = z
  .object({
    userId: uuid,
    role: appRoleSchema,
    joinedAt: isoDate,
    connection: appParticipantConnectionSchema,
  })
  .strip();

/**
 * What everyone who can view the channel knows about its live session: enough
 * for the card, the strip and the presence line. No state, no seat ids.
 */
export const appSessionSummarySchema = z
  .object({
    id: uuid,
    appId: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/),
    appVersion: z.string().max(64),
    startedBy: uuid.nullable(),
    hostUserId: uuid.nullable(),
    startedAt: isoDate,
    participants: z.array(appSessionSummaryParticipantSchema).max(APP_MAX_PARTICIPANTS),
    players: z.number().int().min(0),
    spectators: z.number().int().min(0),
    /** Set while a host handoff is counting down. */
    handoff: z
      .object({ toUserId: uuid.nullable(), at: isoDate })
      .strip()
      .nullable(),
  })
  .strip();
export type AppSessionSummary = z.infer<typeof appSessionSummarySchema>;

/** To everyone who can view the channel. `session: null` means none is live. */
export const channelAppSchema = z
  .object({
    type: z.literal("channel-app"),
    channelId: uuid,
    session: appSessionSummarySchema.nullable(),
  })
  .strip();

/** One person in a session, as its participants see it. */
export const appSessionParticipantSchema = z
  .object({
    seatId: seatIdSchema,
    userId: uuid,
    role: appRoleSchema,
    isHost: z.boolean(),
    connection: appParticipantConnectionSchema,
    /** Per-app derived id, only for people who consented. */
    appUserId: appUserIdSchema.optional(),
  })
  .strip();

/** Snapshot sent to a participant when they join or resume. */
export const appSessionSchema = z
  .object({
    type: z.literal("app-session"),
    sessionId: uuid,
    seatId: seatIdSchema,
    role: appRoleSchema,
    isHost: z.boolean(),
    state: stateSnapshotSchema,
    participants: z.array(appSessionParticipantSchema).max(APP_MAX_PARTICIPANTS),
  })
  .strip();

export const appStateSchema = z
  .object({
    type: z.literal("app-state"),
    sessionId: uuid,
    rev: stateRevSchema,
    value: stateValueSchema,
  })
  .strip();

export const appEventSchema = z
  .object({
    type: z.literal("app-event"),
    sessionId: uuid,
    fromSeatId: seatIdSchema,
    name: eventNameSchema,
    data: eventDataSchema,
  })
  .strip();

export const appEndedSchema = z
  .object({
    type: z.literal("app-ended"),
    sessionId: uuid,
    channelId: uuid,
    reason: appEndReasonSchema,
    summary: z
      .object({
        participants: z.number().int().min(0),
        durationSeconds: z.number().int().min(0),
        /** What the app left in `state.result`, copied at the end (at most 512 bytes). */
        result: appResultSchema,
      })
      .strip(),
  })
  .strip();

export const APP_ERROR_OPS = ["join", "leave", "state", "event"] as const;
export const APP_ERROR_CODES = [
  "full",
  "not-allowed",
  "ended",
  "rate-limited",
  "too-large",
  "stale-rev",
  "unavailable",
] as const;

export const appErrorSchema = z
  .object({
    type: z.literal("app-error"),
    sessionId: uuid,
    op: z.enum(APP_ERROR_OPS),
    code: z.enum(APP_ERROR_CODES),
  })
  .strip();

export const appServerFrameSchema = z.discriminatedUnion("type", [
  channelAppSchema,
  appSessionSchema,
  appStateSchema,
  appEventSchema,
  appEndedSchema,
  appErrorSchema,
]);
export type AppServerFrame = z.infer<typeof appServerFrameSchema>;

export type AppJoin = z.infer<typeof appJoinSchema>;
export type AppLeave = z.infer<typeof appLeaveSchema>;
export type AppStatePatch = z.infer<typeof appStatePatchSchema>;
export type AppEventSend = z.infer<typeof appEventSendSchema>;
export type ChannelApp = z.infer<typeof channelAppSchema>;
export type AppSession = z.infer<typeof appSessionSchema>;
export type AppState = z.infer<typeof appStateSchema>;
export type AppEvent = z.infer<typeof appEventSchema>;
export type AppEnded = z.infer<typeof appEndedSchema>;
export type AppError = z.infer<typeof appErrorSchema>;

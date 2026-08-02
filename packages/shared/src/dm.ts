import { z } from "zod";
import {
  channelKindSchema,
  publicUserSchema,
  unreadCountsSchema,
} from "./api.js";

/**
 * Direct messages, group DMs, and blocking: the wire contract for the first
 * content in this product that is private by default.
 *
 * Everything a conversation carries — messages, edits, reactions, typing, read
 * cursors, attachments — travels on the existing channel-scoped schemas
 * unchanged. What is new is only how a conversation is created, listed, and
 * refused, which is what this file holds.
 */

/**
 * The kinds a conversation can be. Derived from `channelKindSchema` by removing
 * `'server'` rather than written out a second time: a conversation is exactly a
 * channel that is not a server channel, and two independent literal lists would
 * eventually let a server channel parse as a conversation.
 */
export const conversationKindSchema = channelKindSchema.exclude(["server"]);
export type ConversationKind = z.infer<typeof conversationKindSchema>;

/**
 * People in one group conversation, matching Discord's own cap.
 *
 * The limit is not arbitrary and not a performance guard: a conversation has no
 * roles, no owner and no moderator, so there is nobody who can remove somebody
 * from a room that has gone wrong. Small rooms are what makes that
 * simplification survivable — the escape hatch for a bigger group is a server,
 * which has moderation.
 */
export const DM_MAX_PARTICIPANTS = 10;

/** The caller is always a participant, so they may name this many others. */
export const DM_MAX_RECIPIENTS = DM_MAX_PARTICIPANTS - 1;

/**
 * Body of `POST /api/dms`. One id opens a 1:1, more than one opens a group.
 *
 * Duplicates are rejected rather than folded away: two of the same id is a
 * client bug, and quietly collapsing it would turn a request for a group into a
 * 1:1 with somebody the sender did not single out.
 *
 * The caller's own id must not appear, but that cannot be checked here — a
 * schema does not know who is asking. It is not optional either: a self-pair
 * violates the `low_user_id < high_user_id` check on `dm_pairs`, so the route
 * has to reject it before the insert does.
 */
export const createDmSchema = z.object({
  userIds: z
    .array(z.string().uuid())
    .min(1)
    .max(DM_MAX_RECIPIENTS)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "The same person twice is not a group",
    ),
});

export type CreateDmRequest = z.infer<typeof createDmSchema>;

/**
 * One row of the conversation list.
 *
 * `participants` is everybody *except* the viewer. A conversation has no name:
 * the sidebar derives its title and its avatars from this list, so including
 * yourself would put your own face on every 1:1 you are in and would make a
 * two-person row indistinguishable from a three-person one.
 *
 * `lastMessageAt` is null for a conversation nobody has spoken in yet, which is
 * a real state rather than an edge case — opening a DM creates the channel
 * before there is anything in it.
 */
export const dmSummarySchema = z.object({
  channelId: z.string().uuid(),
  kind: conversationKindSchema,
  participants: z.array(publicUserSchema).max(DM_MAX_RECIPIENTS),
  lastMessageAt: z.string().nullable(),
  unread: unreadCountsSchema,
});

export type DmSummary = z.infer<typeof dmSummarySchema>;

export const dmListResponseSchema = z.object({
  conversations: z.array(dmSummarySchema),
});

export type DmListResponse = z.infer<typeof dmListResponseSchema>;

export const createBlockSchema = z.object({
  userId: z.string().uuid(),
});

export type CreateBlockRequest = z.infer<typeof createBlockSchema>;

/**
 * A block as it is listed back to the person who made it.
 *
 * Flattened onto the public user rather than nesting one, matching how a ban is
 * reported. `blockedAt` is the block's own timestamp — a blocked user is still
 * only ever described by `publicUserSchema`, since blocking somebody must not
 * become a way to learn more about them than you could before.
 */
export const blockedUserSchema = publicUserSchema.extend({
  blockedAt: z.string(),
});

export type BlockedUser = z.infer<typeof blockedUserSchema>;

export const blockListResponseSchema = z.object({
  blocked: z.array(blockedUserSchema),
});

export type BlockListResponse = z.infer<typeof blockListResponseSchema>;

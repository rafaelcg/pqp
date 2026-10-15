import { z } from "zod";

/**
 * Seguir: following a Baú so its new free posts are delivered into a channel
 * of another server.
 *
 * A follow is a row `source server -> destination channel`. When the source
 * publishes a FREE post, a background job posts a forward card into the
 * destination channel, authored as the source (a webhook-style identity named
 * after the source server), never as a person. Members-only posts never go
 * out. Edits to the post update the delivered cards; deleting the post (or
 * moving it back to a draft, or locking it for members) removes them.
 *
 * Switched by the per-server runtime flag `bau_follow`, read for the SOURCE
 * server, so the QG opens first and any other community later with no deploy.
 */

/** Follows one destination SERVER may hold, across all of its channels. */
export const BAU_FOLLOW_MAX_PER_SERVER = 20;

/**
 * Deliveries of ONE post per minute, across every follower. A big audience is
 * worked off a minute at a time rather than in one burst of messages.
 */
export const BAU_FOLLOW_MAX_DELIVERIES_PER_POST_PER_MINUTE = 60;

/** Consecutive permission failures after which a follow pauses itself. */
export const BAU_FOLLOW_PAUSE_AFTER_FAILURES = 3;

export const bauFollowStatusSchema = z.enum(["active", "paused"]);
export type BauFollowStatus = z.infer<typeof bauFollowStatusSchema>;

/**
 * Why a follow is paused. Only `permissions` today: whoever set it up lost the
 * right to (or the channel stopped being one they can manage) and delivery
 * failed repeatedly. A follow that is merely switched off at the source (the
 * flag) is not stored as paused; nothing is lost and nothing needs resuming.
 */
export const bauFollowPausedReasonSchema = z.enum(["permissions"]);
export type BauFollowPausedReason = z.infer<typeof bauFollowPausedReasonSchema>;

export const bauFollowSchema = z.object({
  id: z.string().uuid(),
  sourceServerId: z.string().uuid(),
  sourceServerName: z.string(),
  sourceServerIconUrl: z.string().nullable(),
  targetServerId: z.string().uuid(),
  targetServerName: z.string(),
  targetChannelId: z.string().uuid(),
  targetChannelName: z.string(),
  rolePingId: z.string().uuid().nullable(),
  rolePingName: z.string().nullable(),
  status: bauFollowStatusSchema,
  pausedReason: bauFollowPausedReasonSchema.nullable(),
  pausedAt: z.string().nullable(),
  createdAt: z.string(),
  /** Whether the person asking set this follow up. */
  mine: z.boolean(),
});
export type BauFollow = z.infer<typeof bauFollowSchema>;

/**
 * `GET /api/servers/:serverId/home/follow`: is this Baú followable, and what
 * does the viewer follow it with. `enabled` is the `bau_follow` flag for this
 * source. When it is false the other fields are empty and the client shows no
 * Seguir button.
 */
export const bauFollowStateSchema = z.object({
  enabled: z.boolean(),
  maxPerServer: z.number().int().positive(),
  /** Follows of this Baú the viewer created, newest first. */
  mine: z.array(bauFollowSchema),
});
export type BauFollowState = z.infer<typeof bauFollowStateSchema>;

/** A role of a destination server a follow may ping. */
export const bauFollowRoleOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string().nullable(),
});
export type BauFollowRoleOption = z.infer<typeof bauFollowRoleOptionSchema>;

export const bauFollowChannelOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** An active or paused follow of this source already points here. */
  following: z.boolean(),
});
export type BauFollowChannelOption = z.infer<typeof bauFollowChannelOptionSchema>;

export const bauFollowDestinationSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string(),
  serverIconUrl: z.string().nullable(),
  channels: z.array(bauFollowChannelOptionSchema),
  /** Roles the viewer may ping from this server (mentionable, or they may mention everyone). */
  roles: z.array(bauFollowRoleOptionSchema),
  /** How many follows this server already holds, against `maxPerServer`. */
  followCount: z.number().int().nonnegative(),
});
export type BauFollowDestination = z.infer<typeof bauFollowDestinationSchema>;

/**
 * `GET /api/servers/:serverId/home/follow/destinations`: every server of the
 * viewer where they may set a follow up (MANAGE_WEBHOOKS or MANAGE_CHANNELS),
 * with the text channels they may point it at. The server being followed is
 * left out: a Baú is not delivered into itself.
 */
export const bauFollowDestinationsSchema = z.object({
  maxPerServer: z.number().int().positive(),
  servers: z.array(bauFollowDestinationSchema),
});
export type BauFollowDestinations = z.infer<typeof bauFollowDestinationsSchema>;

/** `POST /api/servers/:serverId/home/follow` */
export const createBauFollowSchema = z.object({
  channelId: z.string().uuid(),
  /** A role of the destination server to mention on each delivery. */
  rolePingId: z.string().uuid().nullable().optional(),
});
export type CreateBauFollowRequest = z.infer<typeof createBauFollowSchema>;

/** `PATCH /api/bau-follows/:followId`: change the ping, or resume a paused follow. */
export const updateBauFollowSchema = z
  .object({
    rolePingId: z.string().uuid().nullable().optional(),
    /** `true` resumes a paused follow; deliveries start from the moment of the resume. */
    resume: z.boolean().optional(),
  })
  .refine(
    (value) => value.rolePingId !== undefined || value.resume !== undefined,
    "Nothing to change",
  );
export type UpdateBauFollowRequest = z.infer<typeof updateBauFollowSchema>;

/** `GET /api/channels/:channelId/bau-follows`: what this channel follows. */
export const channelBauFollowsSchema = z.object({
  follows: z.array(bauFollowSchema),
});
export type ChannelBauFollows = z.infer<typeof channelBauFollowsSchema>;

/**
 * A follower as the SOURCE's staff see it: server names, never people. The
 * channel is named because that is where the cards land.
 */
export const bauFollowerSchema = z.object({
  id: z.string().uuid(),
  targetServerId: z.string().uuid(),
  targetServerName: z.string(),
  targetServerIconUrl: z.string().nullable(),
  targetChannelName: z.string(),
  status: bauFollowStatusSchema,
  createdAt: z.string(),
});
export type BauFollower = z.infer<typeof bauFollowerSchema>;

export const bauFollowBlockSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string(),
  createdAt: z.string(),
});
export type BauFollowBlock = z.infer<typeof bauFollowBlockSchema>;

/** `GET /api/servers/:serverId/home/followers` (MANAGE_SERVER). */
export const bauFollowersSchema = z.object({
  enabled: z.boolean(),
  /** Followers across every destination channel (a server with two channels counts twice). */
  count: z.number().int().nonnegative(),
  followers: z.array(bauFollowerSchema),
  blocked: z.array(bauFollowBlockSchema),
});
export type BauFollowers = z.infer<typeof bauFollowersSchema>;

import { z } from "zod";

/**
 * Watch party scheduling: an admin or mod announces the next session on a
 * channel ("Cinemoon, sexta 21h, filme X"), members tap "Lembrar" to be
 * reminded, and the channel shows a countdown. This is deliberately separate
 * from the `watch_party` channel kind another branch is building. A session
 * attaches to any channel id today. Authorisation is `MANAGE_CHANNELS` for
 * now.
 *
 * REPLACE-WHEN-READY: once `START_WATCH_PARTY` (the dedicated permission bit
 * from `feat/watch-party-channel`) lands, swap the `MANAGE_CHANNELS` check in
 * `server/src/api/index.ts`'s session routes for it. That is the one line
 * marked with the same tag there.
 */
export const CHANNEL_SESSION_STATUSES = [
  "scheduled",
  "live",
  "ended",
  "cancelled",
] as const;

export type ChannelSessionStatus = (typeof CHANNEL_SESSION_STATUSES)[number];

export const channelSessionSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  serverId: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  startsAt: z.string(),
  status: z.enum(CHANNEL_SESSION_STATUSES),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Whether the requesting user has an active reminder for this session. */
  reminding: z.boolean(),
});

export type ChannelSession = z.infer<typeof channelSessionSchema>;

const titleField = z.string().trim().min(1).max(120);
const descriptionField = z.string().trim().max(2000).nullable().optional();

export const createChannelSessionSchema = z.object({
  title: titleField,
  /** ISO 8601. Must be in the future. */
  startsAt: z.string().datetime({ offset: true }),
  description: descriptionField,
});

export type CreateChannelSessionInput = z.infer<
  typeof createChannelSessionSchema
>;

export const updateChannelSessionSchema = z.object({
  title: titleField.optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  description: descriptionField,
});

export type UpdateChannelSessionInput = z.infer<
  typeof updateChannelSessionSchema
>;

/** T-10 minutes, and the exact instant "live" fires, see channel-sessions.ts. */
export const CHANNEL_SESSION_REMINDER_LEAD_MINUTES = 10;

/**
 * A session flips to `ended` on its own an hour after `starts_at` if it never
 * went live (nobody started streaming). See `markChannelSessionEnded`.
 */
export const CHANNEL_SESSION_NO_SHOW_MINUTES = 60;

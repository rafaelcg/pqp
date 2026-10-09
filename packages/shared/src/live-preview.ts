import { z } from "zod";

/**
 * The signed-out live preview ("prévia ao vivo"): somebody with no account
 * opens a community's link while a watch party is live, confirms their age,
 * and watches the film in the browser for a few minutes before being asked to
 * sign up. Behind the per-server runtime flag `live_preview` (default off).
 *
 * Design and limits: `docs/WATCH_PARTY.md` §"Watching without an account".
 * Server: `server/src/services/live-preview.ts`. Client:
 * `client/src/lib/live-preview.ts`.
 */

/** Acquisition `medium` for an account that signed up from a preview. */
export const LIVE_PREVIEW_MEDIUM = "live_preview";

/** The default window, per visitor per channel. `LIVE_PREVIEW_SECONDS` moves it. */
export const LIVE_PREVIEW_DEFAULT_SECONDS = 5 * 60;

/** One live channel a signed-out visitor may preview. */
export const livePreviewChannelSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export type LivePreviewChannel = z.infer<typeof livePreviewChannelSchema>;

/** At most this many upcoming sessions are listed. */
export const LIVE_PREVIEW_UPCOMING_MAX = 3;

/**
 * A live channel as the listing describes it: the channel, plus what the
 * page needs to draw the party around the player.
 *
 *  - `title`: the live watch party's own title (`channel_sessions.title`),
 *    null when the stream has no party row (the page then says `#name`).
 *  - `viewers`: how many ACCOUNTS are watching, the count the app's live card
 *    shows (accounts on the playlist plus accounts holding a seat). Preview
 *    visitors are never in it. Absent when it could not be read in time.
 *
 * A count, never who: no id, name or avatar of anybody watching.
 */
export const livePreviewListedChannelSchema = livePreviewChannelSchema.extend({
  title: z.string().nullable().optional(),
  viewers: z.number().int().nonnegative().optional(),
});

export type LivePreviewListedChannel = z.infer<typeof livePreviewListedChannelSchema>;

/**
 * One scheduled session on a channel @everyone can view: the title, when it
 * starts (epoch ms) and the channel's name. Nothing about who made it.
 */
export const livePreviewUpcomingSchema = z.object({
  title: z.string(),
  startsAt: z.number(),
  channelName: z.string(),
});

export type LivePreviewUpcoming = z.infer<typeof livePreviewUpcomingSchema>;

/**
 * `GET /api/public/live-preview/communities/:slug` and
 * `GET /api/public/live-preview/invites/:code`. `channels` is empty while
 * nothing is live; `seconds` is the window a visitor gets per channel;
 * `upcoming` is at most `LIVE_PREVIEW_UPCOMING_MAX` scheduled sessions,
 * soonest first.
 */
export const livePreviewListingSchema = z.object({
  livePreview: z.object({
    channels: z.array(livePreviewListedChannelSchema),
    seconds: z.number().int().positive(),
    upcoming: z.array(livePreviewUpcomingSchema).max(LIVE_PREVIEW_UPCOMING_MAX).default([]),
  }),
});

export type LivePreviewListing = z.infer<typeof livePreviewListingSchema>;

/**
 * `POST /api/public/live-preview/start`. `ageConfirmed` is the visitor's own
 * declaration, made on their device against `MINIMUM_AGE_YEARS`; the date
 * itself never leaves the device. `ticket` is the opaque value an earlier
 * answer handed back, which is what keeps the window from restarting.
 */
export const livePreviewStartSchema = z.object({
  channelId: z.string().uuid(),
  ageConfirmed: z.literal(true),
  ticket: z.string().min(1).max(512).optional(),
});

export type LivePreviewStartInput = z.infer<typeof livePreviewStartSchema>;

/**
 * The film only: no presenter identity, no camera, no viewer count. `hlsUrl`
 * carries a short-lived anonymous capability that expires with the window.
 */
export const livePreviewStreamSchema = z.object({
  hlsUrl: z.string(),
  startedAt: z.number(),
  mode: z.enum(["conventional", "ll"]).optional(),
  partTargetMs: z.number().int().positive().optional(),
});

export type LivePreviewStream = z.infer<typeof livePreviewStreamSchema>;

export const livePreviewStartResponseSchema = z.object({
  stream: livePreviewStreamSchema,
  channel: livePreviewChannelSchema,
  ticket: z.string(),
  /** Epoch ms. The capability in `hlsUrl` stops working at this instant. */
  expiresAt: z.number(),
  /** Milliseconds left in the window when the server answered. */
  remainingMs: z.number().int().nonnegative(),
});

export type LivePreviewStartResponse = z.infer<typeof livePreviewStartResponseSchema>;

/** The error body for a visitor whose window on this channel is used up. */
export const LIVE_PREVIEW_ENDED_ERROR = "preview_ended";

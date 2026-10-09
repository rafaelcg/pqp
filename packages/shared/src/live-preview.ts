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

/**
 * `GET /api/public/live-preview/communities/:slug` and
 * `GET /api/public/live-preview/invites/:code`. `channels` is empty while
 * nothing is live; `seconds` is the window a visitor gets per channel.
 */
export const livePreviewListingSchema = z.object({
  livePreview: z.object({
    channels: z.array(livePreviewChannelSchema),
    seconds: z.number().int().positive(),
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

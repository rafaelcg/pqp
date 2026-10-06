import { z } from "zod";

/**
 * Start-of-stream notices ("Alberto começou a transmitir em #filminho").
 *
 * The decision of WHO is told lives on the server (`server/src/services/
 * stream-alerts.ts`); this file holds what the two halves must agree on: the
 * limits, the default a server gets, and the frame. `docs/plans/WATCH_NOW.md`.
 */

/**
 * A share must still be going this long after it started before anybody is
 * told. A share that is stopped and restarted inside it (a person fixing their
 * capture) would otherwise page people twice, and one that was a mistake pages
 * nobody.
 */
export const STREAM_START_STABLE_MS = 20_000;

/** At most one notice per channel in this window, however many shares start. */
export const STREAM_START_CHANNEL_COOLDOWN_MS = 30 * 60_000;

/**
 * A server with more members than this notifies nobody by default, and neither
 * does any community: telling thousands of people about every share is the one
 * thing this feature must never do. Past the limit only a person who turned it
 * on for that server is told.
 */
export const STREAM_ALERT_DEFAULT_MAX_MEMBERS = 200;

/** Hard ceiling on one notice's audience, opt-ins included. */
export const STREAM_ALERT_MAX_RECIPIENTS = 500;

/**
 * Whether a server notifies a member who has not chosen. One answer for the
 * server's decision and for the menu that shows the switch.
 */
export function streamAlertDefault(input: {
  memberCount: number;
  isCommunity: boolean;
}): boolean {
  return (
    !input.isCommunity &&
    Number.isFinite(input.memberCount) &&
    input.memberCount <= STREAM_ALERT_DEFAULT_MAX_MEMBERS
  );
}

/**
 * The person's own choice for one server (`notifications.streamAlerts`) over
 * the server's default. `undefined` means they never chose.
 */
export function streamAlertEnabled(
  choice: boolean | undefined,
  input: { memberCount: number; isCommunity: boolean },
): boolean {
  return choice ?? streamAlertDefault(input);
}

/**
 * Server -> one person's sockets. Addressed per person (the audience is a
 * decided list, not "everyone who can see the channel"), so it is routed like
 * `channel-session-reminder`: out of `CHAT_SERVER_MESSAGE_TYPES`, never through
 * the per-channel relay.
 *
 * Carries only names the recipient can already see on the sidebar.
 */
export const streamStartedSchema = z.object({
  type: z.literal("stream-started"),
  serverId: z.string().uuid(),
  channelId: z.string().uuid(),
  /** The voice channel's name, or the party's own name when `kind` is `party`. */
  channelName: z.string(),
  serverName: z.string(),
  sharerName: z.string(),
  kind: z.enum(["voice", "party"]),
  /** Epoch milliseconds the stream started. */
  startedAt: z.number().int().nonnegative(),
});

export type StreamStartedMessage = z.infer<typeof streamStartedSchema>;

/** `GET /api/servers/:id/stream-alerts`. */
export const streamAlertSettingSchema = z.object({
  /** `stream_start_notifications` is on for this server. */
  flag: z.boolean(),
  /** What this person gets: their choice, else the default. */
  enabled: z.boolean(),
  /** What a person who never chose gets here. */
  default: z.boolean(),
  memberCount: z.number().int().nonnegative(),
});

export type StreamAlertSetting = z.infer<typeof streamAlertSettingSchema>;

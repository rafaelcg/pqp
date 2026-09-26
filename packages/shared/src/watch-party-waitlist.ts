import { z } from "zod";
import { safeTextSchema } from "./api.js";

/**
 * The watch party waitlist: somebody on a server where watch parties are not
 * on yet says "we want this", and the operator turns it on by hand from the
 * dashboard (`docs/WATCH_PARTY.md` §"The waitlist").
 *
 * TWO KINDS OF ROW, ONE TABLE. A `request` is somebody who may manage the
 * server's channels asking for their server; that is the row the operator
 * acts on. An `interest` is an ordinary member (or somebody with no server
 * yet) saying they would watch; it is counted, never acted on, and it is what
 * tells a request from a room of 3 apart from one with 60 people behind it.
 * The server decides which kind a row is, from the caller's permissions, so
 * the client never gets to claim it.
 */

/** Roughly how many would watch. Ranges, because nobody knows the number. */
export const WATCH_PARTY_AUDIENCE_BUCKETS = [
  "under-20",
  "20-50",
  "50-150",
  "150-500",
  "500-plus",
] as const;
export type WatchPartyAudienceBucket =
  (typeof WATCH_PARTY_AUDIENCE_BUCKETS)[number];

export const WATCH_PARTY_WAITLIST_KINDS = ["request", "interest"] as const;
export type WatchPartyWaitlistKind = (typeof WATCH_PARTY_WAITLIST_KINDS)[number];

export const WATCH_PARTY_WAITLIST_STATUSES = [
  "waiting",
  "approved",
  "declined",
] as const;
export type WatchPartyWaitlistStatus =
  (typeof WATCH_PARTY_WAITLIST_STATUSES)[number];

/** "What do you want to watch", short on purpose: a line, not a pitch. */
export const WATCH_PARTY_WAITLIST_NOTE_MAX = 140;

/**
 * A Twitch or Kick channel, as somebody would paste it: `twitch.tv/foo`,
 * `https://www.kick.com/foo`, or just `foo`. Normalised to `twitch.tv/foo`,
 * `kick.com/foo` or the bare name, lower case, so the operator reads one
 * shape. Anything else (another site, a path, spaces) is refused rather than
 * stored: this field is shown on the dashboard as a link.
 */
const CHANNEL_NAME = /^[a-z0-9_]{2,25}$/;

export function normalizeStreamChannel(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^@/, "");
  if (value === "") {
    return null;
  }
  const url = value
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.|m\.)/, "")
    .replace(/\/+$/, "");
  const match = /^(twitch\.tv|kick\.com)\/([^/?#]+)$/.exec(url);
  if (match) {
    return CHANNEL_NAME.test(match[2]!) ? `${match[1]}/${match[2]}` : null;
  }
  return CHANNEL_NAME.test(url) ? url : null;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .pipe(safeTextSchema)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null));

export const joinWatchPartyWaitlistSchema = z.object({
  /**
   * The server this is about. Null is "I would watch, I have no server to
   * ask for": the marketing page's visitor who signed up with nothing yet.
   */
  serverId: z.string().uuid().nullable(),
  audienceBucket: z.enum(WATCH_PARTY_AUDIENCE_BUCKETS).nullable().optional(),
  note: optionalText(WATCH_PARTY_WAITLIST_NOTE_MAX),
  streamChannel: z
    .string()
    .max(120)
    .optional()
    .nullable()
    .transform((value, ctx) => {
      if (!value || value.trim() === "") {
        return null;
      }
      const normalized = normalizeStreamChannel(value);
      if (!normalized) {
        ctx.addIssue({ code: "custom", message: "Invalid Twitch or Kick channel" });
        return z.NEVER;
      }
      return normalized;
    }),
});
export type JoinWatchPartyWaitlistRequest = z.input<
  typeof joinWatchPartyWaitlistSchema
>;

/** The caller's own row. Never anybody else's. */
export const watchPartyWaitlistEntrySchema = z.object({
  serverId: z.string().uuid().nullable(),
  kind: z.enum(WATCH_PARTY_WAITLIST_KINDS),
  status: z.enum(WATCH_PARTY_WAITLIST_STATUSES),
  audienceBucket: z.enum(WATCH_PARTY_AUDIENCE_BUCKETS).nullable(),
  note: z.string().nullable(),
  streamChannel: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type WatchPartyWaitlistEntry = z.infer<
  typeof watchPartyWaitlistEntrySchema
>;

/** `GET /api/watch-party/waitlist?serverId=`. */
export const watchPartyWaitlistStateSchema = z.object({
  /**
   * Whether this deployment is running the campaign at all
   * (`WATCH_PARTY_WAITLIST`, which follows `LIVE_HLS_ENABLED` when unset). A
   * self-host that cannot run a watch party must never tease one.
   */
  campaign: z.boolean(),
  /** The caller may ask for THIS server (MANAGE_CHANNELS or MANAGE_SERVER). */
  canRequest: z.boolean(),
  /** Watch parties already run here, so there is nothing to wait for. */
  available: z.boolean(),
  entry: watchPartyWaitlistEntrySchema.nullable(),
});
export type WatchPartyWaitlistState = z.infer<
  typeof watchPartyWaitlistStateSchema
>;

/** A server the caller waited for that has since been switched on. */
export const watchPartyWaitlistApprovalSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string(),
  kind: z.enum(WATCH_PARTY_WAITLIST_KINDS),
  decidedAt: z.string(),
});
export type WatchPartyWaitlistApproval = z.infer<
  typeof watchPartyWaitlistApprovalSchema
>;

export const ackWatchPartyWaitlistApprovalSchema = z.object({
  serverId: z.string().uuid(),
});

/**
 * The live half of "avisamos aqui quando liberar": sent to every socket of
 * each person whose waiting row the operator just approved. Per user, so it
 * is out of `CHAT_SERVER_MESSAGE_TYPES` like `friend-activity`. The durable
 * half is `GET /api/watch-party/waitlist/approvals`, which a client asks at
 * boot, so somebody offline when it happened still hears about it.
 */
export const watchPartyWaitlistApprovedSchema = z.object({
  type: z.literal("watch-party-waitlist-approved"),
  serverId: z.string().uuid(),
  serverName: z.string(),
});
export type WatchPartyWaitlistApprovedMessage = z.infer<
  typeof watchPartyWaitlistApprovedSchema
>;

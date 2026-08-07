import { z } from "zod";
import { safeTextSchema } from "./api.js";

/**
 * Temporary sanctions — the middle of the enforcement ladder.
 *
 * Before this existed the ladder was: delete one message, or ban the account.
 * A moderator's realistic answer to most reports is "stop doing that for an
 * hour", and there was nothing between the two that could say it. A timeout is
 * that thing, and the shape of it is decided by three rules:
 *
 * 1. **SERVER-WIDE, NOT PER-CHANNEL.** A timeout is about a *person's* conduct,
 *    not a room. Somebody told to stop in #general who carries the same
 *    behaviour into #off-topic has not been stopped, so a per-channel sanction
 *    would need the moderator to guess where the person will go next and would
 *    turn one decision into N rows and a channel picker. The surgical version
 *    is genuinely more expressive and it buys nothing a moderator asked for.
 *
 * 2. **IT NEVER REACHES A CONVERSATION.** A server's moderators have no
 *    authority over their members' direct messages — that is the same rule
 *    `channelVisibleSql` refuses to add a role escape hatch to, and the same
 *    one that routes DM reports away from server queues. A timeout issued in a
 *    server stops participation *in that server*. It is not a platform ban and
 *    must never silently become one.
 *
 * 3. **IT TAKES AWAY SPEAKING, NOT READING.** The person stays a member, keeps
 *    their roles, keeps their history, and can still read every channel they
 *    could read before. That is the entire difference between this and a kick,
 *    and it is what makes a timeout usable for a first offence: the cost of
 *    getting it wrong is an hour of silence, not an ejection.
 */

/** Below a minute there is nothing to serve; the row would expire before the
 * moderator finished reading the confirmation. */
export const TIMEOUT_MIN_MINUTES = 1;

/**
 * 28 days, the same ceiling Discord uses.
 *
 * A cap matters more than its exact value: without one, "timeout" becomes an
 * indefinite mute that nobody ever revisits and that no appeal process covers —
 * a ban with none of a ban's honesty about what it is. Anything that should
 * outlast four weeks is a ban, and the moderator should have to say so.
 */
export const TIMEOUT_MAX_MINUTES = 60 * 24 * 28;

/** What the UI offers by default. Any value in range is still accepted. */
export const TIMEOUT_PRESET_MINUTES = [
  5,
  60,
  60 * 24,
  60 * 24 * 7,
] as const;

export const TIMEOUT_REASON_MAX_LENGTH = 500;

const timeoutMinutesSchema = z
  .number()
  .int()
  .min(TIMEOUT_MIN_MINUTES)
  .max(TIMEOUT_MAX_MINUTES);

const timeoutReasonSchema = z
  .string()
  .max(TIMEOUT_REASON_MAX_LENGTH)
  .pipe(safeTextSchema)
  .nullable()
  .optional();

/**
 * Issue a timeout.
 *
 * A duration in minutes, not an absolute instant. A client sending `expiresAt`
 * would be sending a timestamp computed against its own clock, which is the one
 * input the sanctioned party's side of the conversation can influence; the
 * server turns minutes into `NOW() + interval` so the expiry is always anchored
 * to the database's clock, the same clock every read compares against.
 */
export const issueTimeoutSchema = z.object({
  userId: z.string().uuid(),
  minutes: timeoutMinutesSchema,
  reason: timeoutReasonSchema,
});
export type IssueTimeoutRequest = z.infer<typeof issueTimeoutSchema>;

/**
 * An active timeout, as a moderator sees it in the members panel.
 *
 * Carries all four things a solo operator needs to reconstruct what they did
 * last week without opening the audit log: who did it, when, why, and when it
 * ends. A sanction whose history nobody can see is how a moderator loses track.
 */
export const memberTimeoutSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  tag: z.string().nullable(),
  /** Null once the moderator's own account is gone — `ON DELETE SET NULL`. */
  issuedById: z.string().uuid().nullable(),
  issuedByName: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type MemberTimeout = z.infer<typeof memberTimeoutSchema>;

export const memberTimeoutListSchema = z.object({
  timeouts: z.array(memberTimeoutSchema),
});
export type MemberTimeoutList = z.infer<typeof memberTimeoutListSchema>;

/**
 * What a timed-out client is told over the socket when a frame is refused.
 *
 * DELIBERATELY NOT A MEMBER OF `chatServerMessageSchema`, and this is the one
 * surprising thing in this file. `client/src/App.tsx` routes inbound frames
 * with an explicit allowlist of chat types and passes *everything else* to the
 * voice signaling handler; adding a member to the chat union without adding it
 * to that allowlist is a type error in App.tsx, and adding it there is owned by
 * another work stream. `realtime.ts` does no runtime validation, so a client
 * that does not know this frame receives it and drops it harmlessly, and one
 * line in each of those two files lights it up. The server sends it either way,
 * because the alternative — a send that silently fails and shows as a red
 * bubble — is exactly the "indistinguishable from a bug" outcome this frame
 * exists to prevent, and because the iOS client parses frames by type rather
 * than by that allowlist.
 */
export const sanctionNoticeSchema = z.object({
  type: z.literal("sanction-notice"),
  sanction: z.literal("timeout"),
  serverId: z.string().uuid(),
  /** Where they tried to act. Lets a client attach the notice to the composer
   * they are actually looking at rather than to the app as a whole. */
  channelId: z.string().uuid(),
  expiresAt: z.string(),
  reason: z.string().nullable(),
  /** The whole sentence, already written. A client that renders nothing but
   * this string is a correct client — see `describeTimeout`. */
  message: z.string(),
});
export type SanctionNotice = z.infer<typeof sanctionNoticeSchema>;

/**
 * The sentence a timed-out person reads, on every surface.
 *
 * One function so the HTTP 403 body, the WebSocket notice and any client that
 * wants to re-render it locally cannot drift into three different explanations
 * of the same state. It always names the end time, because "you are timed out"
 * without one is indistinguishable from "you are banned" and leaves the person
 * with nothing to do but keep retrying.
 */
export function describeTimeout(expiresAt: string | Date): string {
  const iso =
    expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;
  return `You are timed out in this server until ${iso}. You can still read, but you cannot post, react or join voice until then.`;
}

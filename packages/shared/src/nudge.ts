import { z } from "zod";

/**
 * CHAMAR A ATENÇÃO (the nudge).
 *
 * A one-tap "hey, look here" between two friends in a 1:1 conversation. The
 * receiving window gives a short shake and a sound; everybody else, and every
 * client that predates this file, sees an ordinary message whose body is
 * `NUDGE_BODY`.
 *
 * IT IS A MESSAGE, NOT A SIDE CHANNEL. The server stores it as a row in
 * `messages` with `system_kind = 'nudge'` and fans it out through the same
 * `message-broadcast` / `channel-activity` path as any send, so unread,
 * history, push, report and the cluster relay all come for free, and an old
 * phone renders a plain `📳` bubble instead of breaking. Precedent: `chance`
 * (a structured field beside a plaintext body).
 *
 * The rules (all enforced server side, cheapest first, see
 * `server/src/services/nudge.ts`):
 *
 *  - only while the `nudge` runtime flag is on;
 *  - only in a 1:1 conversation (`kind = 'dm'`), only between friends, never
 *    through a block;
 *  - one per `NUDGE_COOLDOWN_MS` per sender per conversation, and at most
 *    `NUDGE_SENDER_BURST` per sender across conversations;
 *  - at most `NUDGE_UNANSWERED_MAX` in a row with no reply;
 *  - refused while the receiver shows Não perturbe (`busy`);
 *  - `allowNudges: false` in a person's preferences turns it off in BOTH
 *    directions: nobody nudges them and they nudge nobody.
 */

/** The stored body. Old clients render exactly this, so it must stay readable. */
export const NUDGE_BODY = "📳";

/** One nudge per sender per conversation in this window. */
export const NUDGE_COOLDOWN_MS = 10_000;

/** At most this many nudges in a row from one sender with no reply between. */
export const NUDGE_UNANSWERED_MAX = 3;

/** Per sender, across every conversation: the burst. */
export const NUDGE_SENDER_BURST = 5;

/** Per sender: one token back every this many milliseconds. */
export const NUDGE_SENDER_REFILL_MS = 30_000;

/**
 * How old a nudge may be on receipt and still shake the window. A message
 * older than this is history (a reload, a reconnect backfill, a slow socket)
 * and renders as its line only. Client-side rule, shared so every client
 * agrees.
 */
export const NUDGE_FRESH_MS = 15_000;

/**
 * What a message is, when it is not just text somebody typed. `.catch(null)`
 * so a kind added later never fails today's parse of a whole message: an
 * unknown kind reads as an ordinary message, which is what its body is for.
 *
 * Nullish rather than defaulted: absent (an older API, an optimistic bubble a
 * client built itself) and null both mean "an ordinary message", and every
 * reader asks `systemKind === "nudge"`, so neither needs to be spelled out.
 */
export const MESSAGE_SYSTEM_KINDS = ["nudge"] as const;
export const messageSystemKindSchema = z
  .enum(MESSAGE_SYSTEM_KINDS)
  .nullish()
  .catch(null);
export type MessageSystemKind = (typeof MESSAGE_SYSTEM_KINDS)[number];

/** Client to server: nudge the other person in this conversation. */
export const nudgeFrameSchema = z.object({
  type: z.literal("nudge"),
  channelId: z.string().uuid(),
  /**
   * Same idempotency as `message-create`: a replay of a nudge that already
   * landed is answered with the stored message instead of a second shake.
   */
  nonce: z.string().min(1).max(64).optional(),
});
export type NudgeFrame = z.infer<typeof nudgeFrameSchema>;

/**
 * Why a nudge did not land. Machine tokens; every client localises them.
 *
 * - `cooldown`: too soon after the last one (`retryAfterMs` says how long).
 * - `unanswered`: already `NUDGE_UNANSWERED_MAX` in a row with no reply.
 * - `busy`: the other person is on Não perturbe. Their status is already on
 *   screen, so saying so leaks nothing.
 * - `self-off`: the sender turned nudges off for themselves.
 * - `unavailable`: everything else, ONE token on purpose: not friends, a
 *   block either way, the other person opted out, not a 1:1, the feature is
 *   off. Telling those apart would make the nudge an oracle for a block or a
 *   preference (same rule as `message-rejected`'s `undeliverable`).
 */
export const NUDGE_REFUSAL_REASONS = [
  "cooldown",
  "unanswered",
  "busy",
  "self-off",
  "unavailable",
] as const;
export const nudgeRefusalReasonSchema = z.enum(NUDGE_REFUSAL_REASONS);
export type NudgeRefusalReason = (typeof NUDGE_REFUSAL_REASONS)[number];

/**
 * Server to the sender only, never to the channel: the nudge did not land.
 * Nothing was stored. Not in `CHAT_SERVER_MESSAGE_TYPES`, for the same reason
 * `message-rejected` is not: the cluster relay must never hand one person's
 * refusal to a whole conversation.
 */
export const nudgeRefusedSchema = z.object({
  type: z.literal("nudge-refused"),
  channelId: z.string().uuid(),
  /** Echo of the frame's nonce, when it had one. */
  nonce: z.string().min(1).max(64).optional(),
  reason: nudgeRefusalReasonSchema,
  /** With `cooldown`: how long until the next one would be taken. */
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type NudgeRefused = z.infer<typeof nudgeRefusedSchema>;

/** The two-way opt-out, with its default applied: on unless turned off. */
export function nudgesAllowed(
  preferences: { allowNudges?: boolean } | null | undefined,
): boolean {
  return preferences?.allowNudges !== false;
}

/**
 * Whether a nudge just received should shake the window, play the sound and
 * buzz. Only a fresh one from somebody else does: a nudge read out of
 * history, replayed after a reconnect or sent by me is a line and nothing
 * more. Pure, so every client can pin the rule with the same table.
 */
export function isFreshNudge(
  message: { systemKind?: MessageSystemKind | null; authorId: string; createdAt: string },
  viewerId: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (message.systemKind !== "nudge") {
    return false;
  }
  if (viewerId && message.authorId === viewerId) {
    return false;
  }
  const created = Date.parse(message.createdAt);
  if (!Number.isFinite(created)) {
    return false;
  }
  const age = now - created;
  // A little slack below zero: the server's clock may be ahead of ours.
  return age >= -NUDGE_FRESH_MS && age < NUDGE_FRESH_MS;
}

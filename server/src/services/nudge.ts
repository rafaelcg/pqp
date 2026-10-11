import {
  NUDGE_COOLDOWN_MS,
  NUDGE_REFUSAL_REASONS,
  NUDGE_SENDER_BURST,
  NUDGE_SENDER_REFILL_MS,
  NUDGE_UNANSWERED_MAX,
  nudgesAllowed,
  type NudgeRefusalReason,
} from "@pqp/shared";
import { getPool } from "../db.js";
import {
  refundSharedRateLimit,
  sharedRateLimit,
  sharedRateLimitRetryAfterMs,
  type SharedBucketOptions,
} from "../lib/cluster-rate-limit.js";
import { isEnabled } from "../lib/flags.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { resolveStatus } from "../ws/status.js";
import { noBlockBetweenSql } from "./blocks.js";
import { areFriendsSql } from "./friends.js";
import { getPreferencesForUsers } from "./preferences.js";

/**
 * CHAMAR A ATENÇÃO, THE SERVER'S RULES.
 *
 * Everything that decides whether a `nudge` frame becomes a message, in the
 * order the design fixed (cheapest first, except that the cooldown is spent
 * last so a refused attempt never costs a token), so the socket handler in
 * `ws/chat.ts` only has to ask once and then write through the ordinary send
 * path. The rules themselves are in `packages/shared/src/nudge.ts`.
 *
 * TWO LIMITERS, EACH IN TWO PLACES. Production runs two API machines, and a
 * person with a tab on each would get two in-memory buckets, which for a
 * budget whose whole point is "the other person is not buzzed more than once
 * every ten seconds" is a real defect. So each budget is the in-memory bucket
 * (free, and it answers `retryAfterMs`) AND one row in `rate_limit_buckets`
 * spent atomically (`sharedRateLimit`, exact across machines, fails open on a
 * database blip so the in-memory one is the backstop). A nudge is rare enough
 * that the round trip costs nothing anyone will notice.
 *
 * WHAT IS TOLD TO WHOM. Every refusal that would reveal something about the
 * other person (a block either way, not friends, they opted out) is the one
 * token `unavailable`. `busy` is Não perturbe, which the sender can already see
 * on the other person's face; `unanswered` is the sender's own history. Both
 * are therefore safe to name, and naming them is what turns a dead button into
 * "manda uma mensagem".
 */

const conversationLimiter = createRateLimiter({
  capacity: 1,
  refillPerSecond: 1000 / NUDGE_COOLDOWN_MS,
});

const senderLimiter = createRateLimiter({
  capacity: NUDGE_SENDER_BURST,
  refillPerSecond: 1000 / NUDGE_SENDER_REFILL_MS,
});

const CONVERSATION_BUCKET: SharedBucketOptions = {
  bucket: "nudge.conversation",
  capacity: 1,
  refillPerSecond: 1000 / NUDGE_COOLDOWN_MS,
};

const SENDER_BUCKET: SharedBucketOptions = {
  bucket: "nudge.sender",
  capacity: NUDGE_SENDER_BURST,
  refillPerSecond: 1000 / NUDGE_SENDER_REFILL_MS,
};

// ------------------------------------------------------------------ counters

/**
 * `nudge` on `GET /api/admin/metrics`. In-process and cumulative since boot,
 * like `voiceNotes.refusals`: the exporter sums the replicas. `unanswered`
 * and `cooldown` climbing is somebody hammering a friend; `unavailable`
 * climbing with `sent` flat is a client offering the button where the server
 * will never accept it.
 */
let sent = 0;
const refused = new Map<NudgeRefusalReason, number>();

export function recordNudgeSent(): void {
  sent += 1;
}

export function recordNudgeRefused(reason: NudgeRefusalReason): void {
  refused.set(reason, (refused.get(reason) ?? 0) + 1);
}

export interface NudgeMetrics {
  /** Whether the `nudge` flag is on right now, on this process. */
  enabled: boolean;
  sent: number;
  /** Every reason pre-seeded to zero, so a series exists before its first event. */
  refused: Record<NudgeRefusalReason, number>;
}

export function nudgeMetrics(): NudgeMetrics {
  const out = {} as Record<NudgeRefusalReason, number>;
  for (const reason of NUDGE_REFUSAL_REASONS) {
    out[reason] = refused.get(reason) ?? 0;
  }
  return { enabled: isEnabled("nudge"), sent, refused: out };
}

/** Test hook: counters and both in-memory limiters. */
export function resetNudgeStateForTests(): void {
  sent = 0;
  refused.clear();
  conversationLimiter.reset();
  senderLimiter.reset();
}

// ---------------------------------------------------------------- the rules

export type NudgeDecision =
  | { ok: true; peerId: string }
  | { ok: false; reason: NudgeRefusalReason; retryAfterMs?: number };

/** A shared spend that never throws: a database blip must not stop the nudge. */
async function spendShared(
  options: SharedBucketOptions,
  subject: string,
): Promise<boolean> {
  try {
    return await sharedRateLimit(options, subject);
  } catch (error) {
    console.error(`[nudge] shared bucket ${options.bucket} failed open:`, error);
    return true;
  }
}

async function sharedRetryAfterMs(
  options: SharedBucketOptions,
  subject: string,
): Promise<number> {
  try {
    return await sharedRateLimitRetryAfterMs(options, subject);
  } catch {
    return Math.ceil(1000 / options.refillPerSecond);
  }
}

/**
 * The two cooldowns, conversation first. Both in-memory buckets are spent
 * before either shared one, so a frame refused here costs no database write.
 */
async function takeBudget(
  senderId: string,
  channelId: string,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const conversationKey = `${senderId}:${channelId}`;
  if (!conversationLimiter.take(conversationKey)) {
    return {
      ok: false,
      retryAfterMs: conversationLimiter.retryAfter(conversationKey) * 1000,
    };
  }
  if (!senderLimiter.take(senderId)) {
    return { ok: false, retryAfterMs: senderLimiter.retryAfter(senderId) * 1000 };
  }
  if (!(await spendShared(CONVERSATION_BUCKET, conversationKey))) {
    return {
      ok: false,
      retryAfterMs: await sharedRetryAfterMs(CONVERSATION_BUCKET, conversationKey),
    };
  }
  if (!(await spendShared(SENDER_BUCKET, senderId))) {
    return {
      ok: false,
      retryAfterMs: await sharedRetryAfterMs(SENDER_BUCKET, senderId),
    };
  }
  return { ok: true };
}

/**
 * Hand back what `takeBudget` spent, for a nudge that passed every rule and
 * then failed to be stored or sent (no access after all, a block that landed
 * in between, the database). Without this the sender would be told "wait"
 * for a nudge nobody received. In-memory buckets take a negative cost (the
 * next refill clamps them to capacity); the shared rows are topped up by one.
 * Never throws.
 */
export async function refundNudgeBudget(senderId: string, channelId: string): Promise<void> {
  const conversationKey = `${senderId}:${channelId}`;
  conversationLimiter.take(conversationKey, -1);
  senderLimiter.take(senderId, -1);
  try {
    await refundSharedRateLimit(CONVERSATION_BUCKET, conversationKey);
    await refundSharedRateLimit(SENDER_BUCKET, senderId);
  } catch (error) {
    console.error("[nudge] budget refund failed:", error);
  }
}

/**
 * The other person in a 1:1, or null when this is not a 1:1 the sender is in.
 * `dm_pairs` is the durable record of who the two are (it survives either side
 * closing the conversation), and only a `dm` has one: a group never does.
 */
async function peerOf(senderId: string, channelId: string): Promise<string | null> {
  const result = await getPool().query<{ low_user_id: string; high_user_id: string }>(
    `SELECT p.low_user_id, p.high_user_id
       FROM dm_pairs p
       JOIN channels c ON c.id = p.channel_id
      WHERE p.channel_id = $1 AND c.kind = 'dm'`,
    [channelId],
  );
  const pair = result.rows[0];
  if (!pair) {
    return null;
  }
  if (pair.low_user_id === senderId) {
    return pair.high_user_id;
  }
  if (pair.high_user_id === senderId) {
    return pair.low_user_id;
  }
  return null;
}

/** Friends, and no block in either direction, in one round trip. */
async function friendsWithoutBlock(senderId: string, peerId: string): Promise<boolean> {
  const result = await getPool().query<{ friends: boolean; no_block: boolean }>(
    `SELECT ${areFriendsSql("$1::uuid", "$2::uuid")} AS friends,
            ${noBlockBetweenSql("$1::uuid", "$2::uuid")} AS no_block`,
    [senderId, peerId],
  );
  const row = result.rows[0];
  return Boolean(row?.friends && row.no_block);
}

/**
 * True when the newest `NUDGE_UNANSWERED_MAX` messages in the conversation are
 * all nudges from this sender: anything else in between (a reply, or the
 * sender saying something in words) breaks the streak. One indexed read of
 * the conversation's newest rows.
 */
async function isUnanswered(senderId: string, channelId: string): Promise<boolean> {
  const result = await getPool().query<{ author_id: string; system_kind: string | null }>(
    `SELECT author_id, system_kind
       FROM messages
      WHERE channel_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [channelId, NUDGE_UNANSWERED_MAX],
  );
  return (
    result.rows.length >= NUDGE_UNANSWERED_MAX &&
    result.rows.every((row) => row.author_id === senderId && row.system_kind === "nudge")
  );
}

/**
 * Whether `senderId` may nudge the other person in `channelId` right now.
 * Never writes a message; the caller does that through the ordinary send path
 * and counts the outcome.
 */
export async function decideNudge(
  senderId: string,
  channelId: string,
): Promise<NudgeDecision> {
  // 1. The kill switch. Whatever a stale client believes.
  if (!isEnabled("nudge")) {
    return { ok: false, reason: "unavailable" };
  }

  // 2. A 1:1 the sender is in.
  const peerId = await peerOf(senderId, channelId);
  if (!peerId) {
    return { ok: false, reason: "unavailable" };
  }

  // 3. The sender's own switch. Read with the peer's in one query; the peer's
  //    answer is only consulted after the friendship check below (an opted-out
  //    stranger and a non-friend are the same `unavailable`).
  const preferences = await getPreferencesForUsers([senderId, peerId]);
  if (!nudgesAllowed(preferences.get(senderId))) {
    return { ok: false, reason: "self-off" };
  }

  // 4. Friends, and no block either way.
  if (!(await friendsWithoutBlock(senderId, peerId))) {
    return { ok: false, reason: "unavailable" };
  }

  // 5. The other person's switch.
  if (!nudgesAllowed(preferences.get(peerId))) {
    return { ok: false, reason: "unavailable" };
  }

  // 6. Não perturbe, as everybody else sees it (cluster-wide, and never
  //    revealing an invisible person: they resolve to offline).
  if (resolveStatus(peerId) === "dnd") {
    return { ok: false, reason: "busy" };
  }

  // 7. Three in a row with no reply.
  if (await isUnanswered(senderId, channelId)) {
    return { ok: false, reason: "unanswered" };
  }

  // 8. Cooldowns: 10 s per conversation, a burst of five per sender. LAST, so
  //    only a nudge that would otherwise land spends a token: a refusal for
  //    any reason above (or a database error on the way) leaves the sender
  //    free to try again the moment the reason goes away (the friend leaves
  //    Não perturbe, answers, unblocks).
  const budget = await takeBudget(senderId, channelId);
  if (!budget.ok) {
    return { ok: false, reason: "cooldown", retryAfterMs: budget.retryAfterMs };
  }

  return { ok: true, peerId };
}

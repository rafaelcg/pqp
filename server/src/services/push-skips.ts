import { logEvent } from "../lib/log.js";

/**
 * `product.pushSkipped` on `GET /api/admin/metrics`, and the `push.skipped`
 * log line: every push decision that ended in NOT sending, and why.
 *
 * WHY THIS EXISTS. `product.pushDelivery` counts what happened when the server
 * sent. It is silent about the far more common outcome, which is the server
 * deciding not to send at all. On 2026-10-05 Rafael received fourteen DMs with
 * a valid APNs token on file and got zero pushes, and from the server's side
 * that looked exactly like nobody having written to him: no send, no failure,
 * no line. The reason was the live-socket rule (a desktop window somewhere was
 * holding a socket), and nothing said so. This module is the "why not".
 *
 * ONE COUNT PER RECIPIENT PER DECISION, keyed by the kind of push and the
 * first rule that refused it. The order of the rules is the order the pipeline
 * already applies them (`sendChannelPush` and friends in push.ts), so a person
 * who is both connected and on DND is counted as `live_socket`, because that
 * check ran first and the DND row was never read.
 *
 * Cumulative, in-process, per instance, all keys pre-seeded to zero: the same
 * convention as `push-metrics.ts`, so the exporter sums it across replicas.
 * Bounded cardinality: 5 kinds x 8 reasons.
 */

export type PushSkipKind = "message" | "call" | "stream" | "reminder" | "waitlist";

export type PushSkipReason =
  /** A live socket anywhere in the cluster (the rule this module was built to expose). */
  | "live_socket"
  /**
   * With `push_attention_gate` on, the narrower rule: a socket that is
   * foreground and not idle. `live_socket` stops growing once the gate is on.
   */
  | "attentive_socket"
  /** The recipient blocked the author. */
  | "blocked"
  /** Stored do-not-disturb, read at send time. */
  | "dnd"
  /** The resolved level for the channel is `none`. */
  | "muted"
  /** The level allows the channel but not this message (a conversation at `mentions`). */
  | "level"
  /** No row in `push_subscriptions` at all. */
  | "no_subscription"
  /** Rows exist, but none is on a transport this deployment has configured. */
  | "transport_off";

export const PUSH_SKIP_KINDS: readonly PushSkipKind[] = [
  "message",
  "call",
  "stream",
  "reminder",
  "waitlist",
];

export const PUSH_SKIP_REASONS: readonly PushSkipReason[] = [
  "live_socket",
  "attentive_socket",
  "blocked",
  "dnd",
  "muted",
  "level",
  "no_subscription",
  "transport_off",
];

const counts = new Map<string, number>();

function key(kind: PushSkipKind, reason: PushSkipReason): string {
  return `${kind}:${reason}`;
}

/**
 * The log is rate limited per recipient, kind and reason, because the hot
 * reason is hot by construction: every DM to somebody with the app open is a
 * `live_socket` skip, and a busy conversation would otherwise write a line per
 * message. One line per minute per (person, kind, reason) is enough to answer
 * "why did this person get nothing", and `suppressed` says how many the window
 * swallowed. The COUNTER is incremented before the suppression, so it is the
 * true number.
 */
export const PUSH_SKIP_LOG_WINDOW_MS = 60_000;

/**
 * A ceiling on the whole log, not just per person. An `@everyone` in a large
 * server, or a stream start to 500 people who all have the app open, is one
 * decision with hundreds of distinct recipients, and the per-person window
 * does nothing for the first pass. Past this many lines in a second the rest
 * are only counted, and the next line that is written reports how many were
 * dropped (`dropped=`). The counters are unaffected.
 */
export const PUSH_SKIP_LOG_MAX_PER_SECOND = 20;

/**
 * The per-person windows are swept for expired entries at most this often,
 * and only once the map is past `LOG_WINDOW_SWEEP_AT`. A sweep on every
 * insertion above the threshold would be quadratic during exactly the burst
 * it is meant to survive, since nothing in a burst has expired yet.
 */
const LOG_WINDOW_SWEEP_EVERY_MS = 10_000;
const LOG_WINDOW_SWEEP_AT = 5_000;
/**
 * Past this the map takes no new windows until a sweep makes room: a person
 * not tracked is still counted, and their line is subject to the global cap
 * like any other, so the worst case is an extra line per minute for them.
 */
const LOG_WINDOW_MAX = 20_000;
const logWindows = new Map<string, { at: number; suppressed: number }>();
let lastSweepAt = 0;

let secondStartedAt = 0;
let linesThisSecond = 0;
let droppedLines = 0;

function sweepLogWindows(now: number): void {
  if (logWindows.size < LOG_WINDOW_SWEEP_AT || now - lastSweepAt < LOG_WINDOW_SWEEP_EVERY_MS) {
    return;
  }
  lastSweepAt = now;
  for (const [windowKey, window] of logWindows) {
    if (now - window.at >= PUSH_SKIP_LOG_WINDOW_MS) {
      logWindows.delete(windowKey);
    }
  }
}

/** Whether the global per-second ceiling has room for one more line. */
function takeLogLine(now: number): boolean {
  if (now - secondStartedAt >= 1_000) {
    secondStartedAt = now;
    linesThisSecond = 0;
  }
  if (linesThisSecond >= PUSH_SKIP_LOG_MAX_PER_SECOND) {
    droppedLines += 1;
    return false;
  }
  linesThisSecond += 1;
  return true;
}

export interface PushSkipContext {
  /** The channel a message push was about (conversations included). */
  channelId?: string;
  /** The conversation a call push was about. */
  conversationId?: string;
}

/** Record that `userId` was not pushed, and why. Never throws. */
export function notePushSkipped(
  kind: PushSkipKind,
  reason: PushSkipReason,
  userId: string,
  context: PushSkipContext = {},
): void {
  const k = key(kind, reason);
  counts.set(k, (counts.get(k) ?? 0) + 1);

  const now = Date.now();
  const windowKey = `${k}:${userId}`;
  const window = logWindows.get(windowKey);
  if (window && now - window.at < PUSH_SKIP_LOG_WINDOW_MS) {
    window.suppressed += 1;
    return;
  }
  sweepLogWindows(now);
  if (!takeLogLine(now)) {
    // Not written, so no window starts: this person's next skip may log.
    return;
  }
  const dropped = droppedLines;
  droppedLines = 0;
  logEvent("push.skipped", {
    kind,
    reason,
    userId,
    channelId: context.channelId,
    conversationId: context.conversationId,
    suppressed: window?.suppressed || undefined,
    dropped: dropped || undefined,
  });
  if (window || logWindows.size < LOG_WINDOW_MAX) {
    logWindows.set(windowKey, { at: now, suppressed: 0 });
  }
}

/** Convenience for a batch that was refused for one reason. */
export function notePushSkippedMany(
  kind: PushSkipKind,
  reason: PushSkipReason,
  userIds: Iterable<string>,
  context: PushSkipContext = {},
): void {
  for (const userId of userIds) {
    notePushSkipped(kind, reason, userId, context);
  }
}

export type PushSkipped = Record<PushSkipKind, Record<PushSkipReason, number>>;

/**
 * `product.pushAttentionPassed`: recipients who HELD a live socket and were
 * let past the socket rule anyway, because none of their sockets was in front
 * of them (`push_attention_gate` on). Under the old rule every one of these
 * was a `live_socket` skip. It counts the gate deciding, not a delivery: the
 * person can still be refused further down (DND, level, no device), which
 * `pushSkipped` then says. Zero while the gate is off.
 */
const attentionPassed = new Map<PushSkipKind, number>();

export function notePushAttentionPassed(kind: PushSkipKind): void {
  attentionPassed.set(kind, (attentionPassed.get(kind) ?? 0) + 1);
}

export type PushAttentionPassed = Record<PushSkipKind, number>;

export function pushAttentionPassedSnapshot(): PushAttentionPassed {
  const out = {} as PushAttentionPassed;
  for (const kind of PUSH_SKIP_KINDS) {
    out[kind] = attentionPassed.get(kind) ?? 0;
  }
  return out;
}

/** Snapshot for `GET /api/admin/metrics`, every key present. */
export function pushSkippedSnapshot(): PushSkipped {
  const out = {} as PushSkipped;
  for (const kind of PUSH_SKIP_KINDS) {
    const perReason = {} as Record<PushSkipReason, number>;
    for (const reason of PUSH_SKIP_REASONS) {
      perReason[reason] = counts.get(key(kind, reason)) ?? 0;
    }
    out[kind] = perReason;
  }
  return out;
}

/** Test seam: forget every count and every log window. */
export function resetPushSkips(): void {
  counts.clear();
  attentionPassed.clear();
  logWindows.clear();
  lastSweepAt = 0;
  secondStartedAt = 0;
  linesThisSecond = 0;
  droppedLines = 0;
}

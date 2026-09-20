/**
 * `product.pushDelivery` on `GET /api/admin/metrics`: the OUTCOME of every
 * push the server sent, per platform, since boot.
 *
 * WHY THIS EXISTS, and how it differs from `product.push`. `product.push`
 * counts push *subscriptions* — rows in `push_subscriptions`, i.e. how many
 * devices could be reached. It says nothing about whether a send worked. The
 * three legs in `push.ts` (`deliverWebPush` / `deliverApns` / `deliverFcm`)
 * each log a `push.*Sent` line on success and a `console.error` on failure,
 * which Loki can rate, but nothing carried a level a "failure rate is high"
 * alert could evaluate `for` a duration. This is that level: three outcomes
 * per platform, counted at the exact branch each leg already takes.
 *
 * THE THREE OUTCOMES.
 *  - `sent`: the vendor accepted it (the `push.*Sent` log line).
 *  - `pruned`: the vendor said the token/subscription is gone (404/410 for
 *    Web Push, `isApnsTokenGone` / `isFcmTokenGone`), and the row was deleted.
 *    This is normal garbage collection, NOT a failure — separated so a healthy
 *    churn of uninstalls does not inflate the failure rate an alert watches.
 *  - `failed`: anything else — a >=400 the vendor did not call "gone", or a
 *    network/transport error. This is the one an alert cares about: a spike
 *    here is an auth/config/outage problem, per the notes in `push.ts`.
 *
 * Cumulative, in-process, per instance — same convention as `calls.*` and the
 * other counters on this endpoint. Bounded cardinality: 3 platforms x 3
 * outcomes, every key pre-seeded to zero.
 */

export type PushPlatform = "web" | "apns" | "fcm";
export type PushOutcome = "sent" | "failed" | "pruned";

const PLATFORMS: readonly PushPlatform[] = ["web", "apns", "fcm"];
const OUTCOMES: readonly PushOutcome[] = ["sent", "failed", "pruned"];

const counts = new Map<string, number>();

function key(platform: PushPlatform, outcome: PushOutcome): string {
  return `${platform}:${outcome}`;
}

/** Record one push send outcome. Called from each leg of `push.ts`. */
export function notePush(platform: PushPlatform, outcome: PushOutcome): void {
  const k = key(platform, outcome);
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

export type PushDelivery = Record<PushPlatform, Record<PushOutcome, number>>;

/** Snapshot for `GET /api/admin/metrics`, all keys present. */
export function pushDeliverySnapshot(): PushDelivery {
  const out = {} as PushDelivery;
  for (const platform of PLATFORMS) {
    const perOutcome = {} as Record<PushOutcome, number>;
    for (const outcome of OUTCOMES) {
      perOutcome[outcome] = counts.get(key(platform, outcome)) ?? 0;
    }
    out[platform] = perOutcome;
  }
  return out;
}

/** Test seam: forget every count. */
export function resetPushMetrics(): void {
  counts.clear();
}

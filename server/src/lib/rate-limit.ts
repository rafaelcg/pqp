/**
 * In-memory token buckets. Single-process only — every replica grants a full
 * bucket of its own, and NOTHING HERE IS ON THE CLUSTER BUS (`lib/bus.ts`).
 * That is a deliberate choice, not an oversight: pub/sub distributes events,
 * and a token bucket needs an atomic decrement. Doing it properly means a
 * round trip to shared storage on the hottest paths in the app — every chat
 * message, every keystroke — which costs more than the limits are worth here.
 *
 * What running N instances actually multiplies, precisely:
 *
 * - **Per-user WS limits** (message / reaction / typing / voice-join, keyed on
 *   the user id in ws/chat.ts and ws/voice.ts) multiply by the number of
 *   instances a single user holds sockets on *at the same time* — one tab is
 *   one instance and is therefore exact; k tabs spread over N instances give
 *   min(k, N) buckets. Flooding through this means opening a socket per
 *   replica, which the connection limits below already bound.
 * - **`socketLimiter` in ws/index.ts**, keyed on client address, becomes N
 *   buckets for the same address — so the join-rate ceiling documented in
 *   docs/LAUNCH.md §T1 rises by N, and the flood backstop weakens by N.
 * - **HTTP limits taken through `rateLimit()`** multiply by N outright:
 *   requests are load balanced per request, so one caller's traffic is spread
 *   across every replica and each grants a full window.
 *
 * If a limit ever has to be exact across replicas, the honest implementation is
 * a shared store (Redis INCR, or a Postgres row with a conditional update) for
 * that specific limit — not gossip over the bus, which is eventually consistent
 * and would let a burst through while it converged.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiter {
  /** Returns true when the caller may proceed. */
  take(key: string, cost?: number): boolean;
  /** Seconds until at least one token is available again. */
  retryAfter(key: string): number;
  reset(key?: string): void;
  size(): number;
}

export interface RateLimitOptions {
  /** Bucket capacity — the largest burst allowed. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Buckets untouched for this long are dropped so the map cannot grow forever. */
  idleTtlMs?: number;
  now?: () => number;
}

/**
 * Positive numeric env override. A test suite that drives one account needs
 * headroom a human never would; production keeps the fallback.
 */
export function limitFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createRateLimiter({
  capacity,
  refillPerSecond,
  idleTtlMs = 10 * 60_000,
  now = Date.now,
}: RateLimitOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let lastSweep = now();

  function sweep(currentTime: number) {
    if (currentTime - lastSweep < idleTtlMs) {
      return;
    }
    lastSweep = currentTime;
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.updatedAt > idleTtlMs) {
        buckets.delete(key);
      }
    }
  }

  function refill(key: string, currentTime: number): Bucket {
    const bucket = buckets.get(key);
    if (!bucket) {
      const created = { tokens: capacity, updatedAt: currentTime };
      buckets.set(key, created);
      return created;
    }
    const elapsedSeconds = (currentTime - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + elapsedSeconds * refillPerSecond,
    );
    bucket.updatedAt = currentTime;
    return bucket;
  }

  return {
    take(key, cost = 1) {
      const currentTime = now();
      sweep(currentTime);
      const bucket = refill(key, currentTime);
      if (bucket.tokens < cost) {
        return false;
      }
      bucket.tokens -= cost;
      return true;
    },

    retryAfter(key) {
      const bucket = buckets.get(key);
      if (!bucket || bucket.tokens >= 1) {
        return 0;
      }
      return Math.ceil((1 - bucket.tokens) / refillPerSecond);
    },

    reset(key) {
      if (key === undefined) {
        buckets.clear();
        return;
      }
      buckets.delete(key);
    },

    size() {
      return buckets.size;
    },
  };
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface SharedBucket extends Bucket {
  capacity: number;
  refillPerMs: number;
}

/**
 * Buckets for one-off checks where the caller carries the budget in the call
 * rather than holding a limiter of its own. The key is expected to name both
 * the bucket and the subject (`api-write:<user id>`), so budgets never mix.
 */
const sharedBuckets = new Map<string, SharedBucket>();

function available(bucket: SharedBucket, now: number): number {
  const elapsed = now - bucket.updatedAt;
  return Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
}

/** Spends one token from the shared bucket named by `key`. */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const refillPerMs = limit / windowMs;
  const existing = sharedBuckets.get(key);
  const tokens = existing ? available(existing, now) : limit;
  const allowed = tokens >= 1;

  sharedBuckets.set(key, {
    tokens: allowed ? tokens - 1 : tokens,
    updatedAt: now,
    capacity: limit,
    refillPerMs,
  });

  return allowed
    ? { allowed: true, retryAfterMs: 0 }
    : { allowed: false, retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) };
}

/** Drop buckets that have refilled, so the map doesn't grow unbounded. */
export function sweepRateLimits(now = Date.now()): void {
  for (const [key, bucket] of sharedBuckets) {
    if (available(bucket, now) >= bucket.capacity) {
      sharedBuckets.delete(key);
    }
  }
}

/** Test helper: wipe all shared bucket state. */
export function resetRateLimits(): void {
  sharedBuckets.clear();
}

/**
 * How many proxies stand in front of this process. `TRUST_PROXY=true` means the
 * one platform edge (Railway, Fly); a number states the depth explicitly for a
 * deployment that stacks another proxy of its own in front of that.
 */
function trustedProxyHops(): number {
  const raw = process.env.TRUST_PROXY;
  if (!raw || raw === "false") {
    return 0;
  }
  if (raw === "true") {
    return 1;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Reads a client address for pre-auth rate limiting. Only trusts
 * `x-forwarded-for` when TRUST_PROXY is on, since it is caller-controlled on a
 * directly exposed server (Railway and Fly both front the app with a proxy).
 *
 * WHICH ENTRY IS READ IS THE WHOLE SECURITY PROPERTY. Each proxy *appends* the
 * address it received the request from, so the rightmost entry is the one our
 * own edge wrote and the leftmost is whatever the caller typed into the header
 * themselves. Counting in from the right is therefore the only way to get an
 * address the client cannot choose — reading the left end lets anyone send
 * `X-Forwarded-For: <random>` and get a fresh, empty rate-limit bucket on every
 * single request, which silently turns every IP-keyed limit into no limit.
 *
 * A chain shorter than the configured depth means the header is not what we
 * assumed, so fall through to the socket address rather than guess.
 */
export function clientAddress(req: {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const forwarded = req.headers["x-forwarded-for"];
    // A header sent more than once arrives as an array, and the hops run in
    // order across the whole list — so join it rather than picking one element.
    const chain = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const candidate = chain[chain.length - hops];
    if (candidate) {
      return candidate;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

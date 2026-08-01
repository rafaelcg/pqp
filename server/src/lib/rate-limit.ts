/**
 * In-memory token buckets. Single-process only, which matches the current
 * single-container Railway deploy — if the API is ever scaled horizontally this
 * needs to move behind Redis, because each replica would otherwise grant a full
 * bucket of its own.
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

/**
 * Reads a client address for pre-auth rate limiting. Only trusts
 * `x-forwarded-for` when TRUST_PROXY is on, since it is caller-controlled on a
 * directly exposed server (Railway and Fly both front the app with a proxy).
 */
export function clientAddress(req: {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

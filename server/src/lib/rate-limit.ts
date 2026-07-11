/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * State is per-process, which matches the rest of the realtime layer (single
 * instance). Keyed by an arbitrary string (typically user id + bucket name).
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (existing.count < limit) {
    existing.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: Math.max(0, existing.resetAt - now) };
}

/** Periodically drop expired windows so the map doesn't grow unbounded. */
export function sweepRateLimits(now = Date.now()): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) {
      windows.delete(key);
    }
  }
}

/** Test helper: wipe all limiter state. */
export function resetRateLimits(): void {
  windows.clear();
}

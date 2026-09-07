import type { IncomingMessage, ServerResponse } from "node:http";
import { getPool } from "../db.js";
import { SECURITY_HEADERS } from "../lib/http.js";
import { clientAddress, createRateLimiter } from "../lib/rate-limit.js";
import { currentPoolStats, type PoolStats } from "../lib/runtime.js";
import { headObject, isStorageConfigured } from "../lib/s3.js";
import { isLiveKitConfigured } from "../voice/backends.js";
import { pingSfu } from "../voice/admin.js";
import { sfuHost } from "../voice/sfu-stats.js";

/**
 * `GET /ready` - the deep check, for external monitors.
 *
 * WHY, WHEN `/health` AND `/up` ALREADY EXIST. On 2026-09-05 production
 * Postgres spent half an hour cutting established connections. Every
 * DB-backed request failed, and nothing fired: `/health` opens a fresh
 * connection for its `SELECT 1`, which kept succeeding, and `/status.json`
 * answers 200 whatever it reports. A monitor pointed at either learned
 * nothing. What actually hurt was the pool: checked-out clients died
 * mid-query, callers queued behind a full pool, and the queue never drained.
 * So this endpoint watches the pool's shape over time as well as whether one
 * more query can be answered, and it says which dependency is the problem.
 *
 * WHAT IT SAYS. `{ ok, checks, version }`, with one entry per dependency
 * (`postgres`, `pool`, `livekit`, `storage`) carrying `ok` and, where probed,
 * `ms`. HTTP 200 only when every check is ok, 503 otherwise. Component
 * labels, booleans, counts and latencies, plus one hostname: the SFU's (see
 * `LivekitCheck` for why). No provider names, no error strings. A stranger
 * learns that "the database is unhappy", which the app being broken already
 * told them.
 *
 * WHAT IT MUST NOT BE. Fly's health check. `fly.toml` points at `/health`,
 * and a dependency-aware check there turns a two-minute Postgres blip into a
 * restart loop of the only machine. Keep `/health` shallow and keep this one
 * off `fly.toml`.
 *
 * THE POOL RULES, which are the part that is not a probe:
 *  - `queued > 0` continuously for longer than `POOL_QUEUE_GRACE_MS` (10 s).
 *    pg-pool queues a request whenever a client cannot be handed over in the
 *    same tick, so a cold start and a deploy stampede both show a queue for a
 *    moment. Momentary is fine. Ten seconds with nobody ever leaving the queue
 *    is a pool that is not serving.
 *  - `inUse == max` continuously for longer than `POOL_FULL_GRACE_MS` (30 s).
 *    A full pool is the normal shape of a burst; a full pool for half a minute
 *    is a set of connections that are hung or leaked.
 * Both are measured in-process by a one-second sampler (`startReadySampler`),
 * and also on every check, so a monitor at 60 s still sees "continuously" and
 * not "at two instants a minute apart".
 *
 * COST. Postgres is one `SELECT 1` per check, bounded by a 2 s timeout and
 * by the rate limiter (a few requests per second per address). LiveKit and
 * object storage are network calls to a third party, so their result is
 * cached for `REMOTE_CACHE_TTL_MS` and concurrent callers share one probe;
 * a monitor cannot make this process hammer the SFU.
 */

export const READY_PATH = "/ready";

export const POSTGRES_TIMEOUT_MS = 2_000;
export const POOL_QUEUE_GRACE_MS = 10_000;
export const POOL_FULL_GRACE_MS = 30_000;
export const REMOTE_TIMEOUT_MS = 3_000;
export const REMOTE_CACHE_TTL_MS = 30_000;
export const POOL_SAMPLE_INTERVAL_MS = 1_000;

export interface ProbeResult {
  ok: boolean;
  ms: number;
}

export type RemoteCheck = ProbeResult | { ok: true; skipped: true };

/**
 * The LiveKit check also names the SFU **host** (hostname only, never the
 * key, the secret, the port or the path). This is the one hostname in the
 * report, and it is here on purpose: production voice moved to a self-hosted
 * SFU on 2026-09-05, a rollback to LiveKit Cloud is a one-line secret change,
 * and a monitor that only says "livekit ok" cannot tell the two apart. Every
 * voice client is handed this same host in its session token, so it is not a
 * secret; it is just not repeated for storage.
 */
export type LivekitCheck = RemoteCheck & { host?: string };

export interface PoolCheck {
  ok: boolean;
  inUse: number;
  max: number;
  queued: number;
}

export interface ReadyReport {
  ok: boolean;
  checks: {
    postgres: ProbeResult;
    pool: PoolCheck;
    livekit: LivekitCheck;
    storage: RemoteCheck;
  };
  version: string;
}

export interface ReadyChecker {
  check(): Promise<ReadyReport>;
  /** Feed one pool sample into the "continuously" clocks. */
  samplePool(): void;
  /** Test hook: forget every clock and cache. */
  reset(): void;
}

export interface ReadyCheckerOptions {
  /** Resolves when Postgres answered `SELECT 1`; rejects or hangs when not. */
  probePostgres: () => Promise<unknown>;
  /** Null when there is no pool yet (before `getPool`, or after `closePool`). */
  poolStats: () => PoolStats | null;
  /**
   * Resolved per check so env read at call time is honoured. Returns null when
   * the dependency is not configured, which is reported as skipped.
   */
  probeLivekit: () => (() => Promise<unknown>) | null;
  /** The SFU hostname to name in the report; null when not configured. */
  livekitHost?: () => string | null;
  probeStorage: () => (() => Promise<unknown>) | null;
  version?: () => string;
  now?: () => number;
  postgresTimeoutMs?: number;
  remoteTimeoutMs?: number;
  remoteCacheTtlMs?: number;
  queueGraceMs?: number;
  fullGraceMs?: number;
}

/**
 * Race a probe against a timer. The loser is abandoned and its rejection
 * swallowed, so a slow dependency never surfaces as an unhandled rejection
 * two ticks after the response went out.
 */
async function timed(
  probe: () => Promise<unknown>,
  timeoutMs: number,
  now: () => number,
): Promise<ProbeResult> {
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const attempt = Promise.resolve()
    .then(probe)
    .then(() => true)
    .catch(() => false);
  try {
    const ok = await Promise.race([attempt, timeout]);
    return { ok, ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Injectable so the judgement can be tested on a fake clock against fake
 * dependencies: the two pool grace windows, the remote cache, the timeouts.
 */
export function createReadyChecker(options: ReadyCheckerOptions): ReadyChecker {
  const now = options.now ?? Date.now;
  const version = options.version ?? (() => process.env.APP_VERSION ?? "dev");
  const postgresTimeoutMs = options.postgresTimeoutMs ?? POSTGRES_TIMEOUT_MS;
  const remoteTimeoutMs = options.remoteTimeoutMs ?? REMOTE_TIMEOUT_MS;
  const remoteCacheTtlMs = options.remoteCacheTtlMs ?? REMOTE_CACHE_TTL_MS;
  const queueGraceMs = options.queueGraceMs ?? POOL_QUEUE_GRACE_MS;
  const fullGraceMs = options.fullGraceMs ?? POOL_FULL_GRACE_MS;

  /** When the current unbroken run of `queued > 0` began; null while clear. */
  let queuedSince: number | null = null;
  /** When the current unbroken run of `inUse == max` began; null while clear. */
  let fullSince: number | null = null;

  function samplePool(): PoolStats | null {
    const stats = options.poolStats();
    const at = now();
    if (!stats) {
      queuedSince = null;
      fullSince = null;
      return null;
    }
    if (stats.waiting > 0) {
      queuedSince ??= at;
    } else {
      queuedSince = null;
    }
    const inUse = Math.max(0, stats.total - stats.idle);
    if (stats.max > 0 && inUse >= stats.max) {
      fullSince ??= at;
    } else {
      fullSince = null;
    }
    return stats;
  }

  function poolCheck(): PoolCheck {
    const stats = samplePool();
    if (!stats) {
      // No pool is not a saturated pool; the postgres probe is what fails
      // when there is no database at all.
      return { ok: true, inUse: 0, max: 0, queued: 0 };
    }
    const at = now();
    const queuedTooLong =
      queuedSince !== null && at - queuedSince > queueGraceMs;
    const fullTooLong = fullSince !== null && at - fullSince > fullGraceMs;
    return {
      ok: !queuedTooLong && !fullTooLong,
      inUse: Math.max(0, stats.total - stats.idle),
      max: stats.max,
      queued: stats.waiting,
    };
  }

  interface RemoteSlot {
    cachedAt: number;
    result: ProbeResult;
    inFlight: Promise<ProbeResult> | null;
  }
  const remote = new Map<string, RemoteSlot>();

  function remoteCheck(
    key: string,
    probe: (() => Promise<unknown>) | null,
  ): Promise<RemoteCheck> {
    if (!probe) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    const at = now();
    const slot = remote.get(key);
    if (slot && at - slot.cachedAt < remoteCacheTtlMs) {
      return Promise.resolve(slot.result);
    }
    if (slot?.inFlight) {
      return slot.inFlight;
    }
    const inFlight = timed(probe, remoteTimeoutMs, now).then((result) => {
      remote.set(key, { cachedAt: now(), result, inFlight: null });
      return result;
    });
    remote.set(key, {
      cachedAt: slot?.cachedAt ?? Number.NEGATIVE_INFINITY,
      result: slot?.result ?? { ok: false, ms: 0 },
      inFlight,
    });
    return inFlight;
  }

  return {
    async check(): Promise<ReadyReport> {
      const [postgres, livekitProbe, storage] = await Promise.all([
        timed(options.probePostgres, postgresTimeoutMs, now),
        remoteCheck("livekit", options.probeLivekit()),
        remoteCheck("storage", options.probeStorage()),
      ]);
      const pool = poolCheck();
      const host = "skipped" in livekitProbe ? null : (options.livekitHost?.() ?? null);
      const livekit: LivekitCheck = host ? { ...livekitProbe, host } : livekitProbe;
      return {
        ok: postgres.ok && pool.ok && livekit.ok && storage.ok,
        checks: { postgres, pool, livekit, storage },
        version: version(),
      };
    },
    samplePool(): void {
      samplePool();
    },
    reset(): void {
      queuedSince = null;
      fullSince = null;
      remote.clear();
    },
  };
}

/**
 * A key that cannot exist: the probe measures "can we reach the bucket and get
 * an authorised answer" (a 404 is a success) without depending on any object
 * being there. Same trick as the status page.
 */
const STORAGE_PROBE_KEY = "__ready_probe__/does-not-exist";

/**
 * The process-wide checker. The optional dependencies are looked up per
 * check, not at import, so an instance without LiveKit or S3 reports them as
 * skipped and a test that sets the env mid-run is seen.
 */
const checker = createReadyChecker({
  // `getPool()` throws without DATABASE_URL, which is correctly "not ok".
  probePostgres: () => getPool().query("SELECT 1"),
  poolStats: currentPoolStats,
  probeLivekit: () => (isLiveKitConfigured() ? () => pingSfu() : null),
  livekitHost: sfuHost,
  probeStorage: () =>
    isStorageConfigured() ? () => headObject(STORAGE_PROBE_KEY) : null,
});

export function checkReady(): Promise<ReadyReport> {
  return checker.check();
}

/** Test hook. */
export function resetReady(): void {
  checker.reset();
}

/**
 * The one-second pool sampler. `unref`'d so it never keeps the process alive;
 * returns the stopper for `shutdown()`.
 */
export function startReadySampler(): () => void {
  const timer = setInterval(() => {
    try {
      checker.samplePool();
    } catch {
      // A sampler must never be the reason a request path throws.
    }
  }, POOL_SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * A few requests per second per address: enough for any monitor, hostile to
 * a scraper. Postgres is probed on every allowed request, so this is what
 * bounds that cost.
 */
const readyLimiter = createRateLimiter({ capacity: 5, refillPerSecond: 2 });

/** Test hook. */
export function resetReadyRateLimit(): void {
  readyLimiter.reset();
}

/**
 * The HTTP handler, injectable for tests. No CORS on purpose: this is for a
 * monitor, not for a browser.
 */
export function readyHandler(
  check: () => Promise<ReadyReport> = checkReady,
  limiter = readyLimiter,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    };
    if (!limiter.take(clientAddress(req))) {
      res.writeHead(429, {
        ...headers,
        "Retry-After": String(limiter.retryAfter(clientAddress(req))),
      });
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
    const report = await check();
    res.writeHead(report.ok ? 200 : 503, headers);
    res.end(JSON.stringify(report));
  };
}

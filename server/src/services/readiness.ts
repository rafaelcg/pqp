import { getPool } from "../db.js";

/**
 * `GET /up` — the one endpoint whose **HTTP status code** is the answer.
 *
 * WHY A NEW PATH. Two endpoints already report health and neither can be
 * pointed at an external monitor:
 *
 *  - `/health` is Fly's health check (`fly.toml`, 30s/5s, gates every release).
 *    It works, and precisely because a deploy depends on it, its semantics are
 *    not ours to change. It also carries `version` — the deployed commit —
 *    which is fine for a platform check and is not something to hand to an
 *    anonymous poller forever.
 *  - `/status.json` returns **200 while reporting components as down**, because
 *    the state lives in the JSON body. UptimeRobot's default check is the HTTP
 *    status, so it would never fire. (Our own GitHub Actions monitor reads that
 *    body — see docs/MONITORING.md — which is why the file has been honest and
 *    useless at the same time without anyone noticing.)
 *
 * So: a third path, whose contract is one bit, expressed as the status code.
 *
 * WHAT IT SAYS, AND ONLY THAT. 200 or 503, and a body of `{"ok":true|false}`.
 * No version, no counts, no hostnames, no timings, no error text — an
 * unauthenticated endpoint that says *why* it is unhealthy is telling a
 * stranger which dependency to lean on. What a caller can learn is: the process
 * accepted a connection, and it either can or cannot reach its database. That
 * is the minimum a monitor needs and it is already implied by the app being
 * up or down.
 *
 * WHEN IT RETURNS 503 — deliberately conservative, because a monitor that
 * cries wolf gets muted and a muted monitor is worse than none:
 *
 *  - the database probe has failed **continuously for at least
 *    `READINESS_GRACE_MS`**. One failed `SELECT 1` is a blip, a failover, a GC
 *    pause; two polls a minute apart failing is an outage. With UptimeRobot at
 *    60s this trips on the second consecutive failed check, i.e. within about
 *    two minutes, and UptimeRobot re-confirms from another location before it
 *    alerts.
 *  - and that is the whole list. In particular:
 *      * a **saturated connection pool is not, by itself, a 503**. It is the
 *        normal shape of a deploy stampede, it self-heals in seconds, and
 *        alerting on it would train the operator to ignore the alert. It is
 *        reported on the dashboard instead (`runtime` in services/metrics.ts).
 *        Note the probe still queues for a client like everything else, so a
 *        pool that is jammed for longer than the grace window *does* read as
 *        unavailable — which is honest: if nothing can get a connection for a
 *        minute, the app is not serving.
 *      * **SIGTERM does not flip it**. Standard readiness practice is to fail
 *        the check while draining so a load balancer sheds traffic, but there
 *        is exactly one machine here (see fly.toml) and nowhere to shed to. All
 *        it would achieve is an alert on every deploy.
 *
 * COST. At most one `SELECT 1` per `READINESS_PROBE_TTL_MS`, however often the
 * endpoint is hit: the probe result is cached for that long and concurrent
 * callers share one in-flight probe. A monitor at 60s therefore costs one
 * query a minute — the same as the status sampler that already runs. That is
 * also why there is no rate limiter on the route: a flood cannot reach the
 * database, and what is left is a constant one-line response.
 */

/** The path. `/up` rather than `/ready`: it is what an operator would guess. */
export const READINESS_PATH = "/up";

/**
 * How long the database has to be continuously unreachable before the endpoint
 * admits it. Shorter than a 60s monitor interval, so two consecutive failed
 * checks always trip it; long enough that a single blip between two checks
 * never does.
 */
export const READINESS_GRACE_MS = 45_000;

/** A probe result is reused for this long. Bounds the cost under a flood. */
export const READINESS_PROBE_TTL_MS = 10_000;

/**
 * A probe that has not answered in this long counts as a failure. Well under
 * the pool's own 10s `connectionTimeoutMillis`, so a hung database produces a
 * fast honest answer rather than a monitor timeout, which is indistinguishable
 * from the network eating the request.
 */
export const READINESS_PROBE_TIMEOUT_MS = 3_000;

export interface ReadinessVerdict {
  status: 200 | 503;
  ok: boolean;
}

export interface ReadinessGate {
  check(): Promise<ReadinessVerdict>;
  /** Test hook: forget the cached probe and the failure streak. */
  reset(): void;
}

export interface ReadinessGateOptions {
  /** Resolves when the dependency answered; rejects or hangs when it did not. */
  probe: () => Promise<unknown>;
  now?: () => number;
  graceMs?: number;
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * Injectable so the decision can be tested against a fake clock and a fake
 * dependency, which is the whole of the logic worth pinning: the grace window,
 * the streak reset on recovery, and the probe coalescing.
 */
export function createReadinessGate(options: ReadinessGateOptions): ReadinessGate {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? READINESS_GRACE_MS;
  const ttlMs = options.ttlMs ?? READINESS_PROBE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? READINESS_PROBE_TIMEOUT_MS;

  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let lastProbeOk = true;
  /** When the current unbroken run of failures started; null while healthy. */
  let failingSince: number | null = null;
  let inFlight: Promise<boolean> | null = null;

  async function runProbe(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      // A probe must never be the reason the process refuses to exit.
      timer.unref?.();
    });
    // The loser of the race is abandoned, so its rejection is swallowed here
    // rather than surfacing as an unhandled rejection two ticks later.
    const attempt = options
      .probe()
      .then(() => true)
      .catch(() => false);
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function probeOnce(): Promise<boolean> {
    const at = now();
    if (at - lastProbeAt < ttlMs) {
      return lastProbeOk;
    }
    if (!inFlight) {
      inFlight = runProbe()
        .then((ok) => {
          lastProbeAt = now();
          lastProbeOk = ok;
          if (ok) {
            // Recovery clears the streak: the window is *continuous* failure,
            // not "failed at some point in the last minute".
            failingSince = null;
          } else if (failingSince === null) {
            failingSince = lastProbeAt;
          }
          return ok;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    async check(): Promise<ReadinessVerdict> {
      const ok = await probeOnce();
      if (ok || failingSince === null) {
        return { status: 200, ok: true };
      }
      const failingFor = now() - failingSince;
      return failingFor >= graceMs
        ? { status: 503, ok: false }
        : // Still inside the grace window: the dependency is unhappy but this
          // has not yet earned a page.
          { status: 200, ok: true };
    },
    reset(): void {
      lastProbeAt = Number.NEGATIVE_INFINITY;
      lastProbeOk = true;
      failingSince = null;
      inFlight = null;
    },
  };
}

/**
 * The process-wide gate. `getPool()` throws when `DATABASE_URL` is unset, which
 * the probe correctly treats as "cannot reach the database" rather than as a
 * crash.
 */
const gate = createReadinessGate({
  probe: () => getPool().query("SELECT 1"),
});

export function checkReadiness(): Promise<ReadinessVerdict> {
  return gate.check();
}

/** Test hook. */
export function resetReadiness(): void {
  gate.reset();
}

/**
 * Graceful shutdown with a sibling to hand over to (M5 of
 * `docs/plans/MULTI_INSTANCE_VOICE.md`).
 *
 * With one machine a deploy closed every socket in the same tick and the
 * clients reconnected to the replacement once it was up; there was nowhere
 * else to go, so nothing here mattered. With two machines the other one is
 * up the whole time, and what matters is the *shape* of the handover:
 *
 *  - `/health` answers 503 the moment SIGTERM lands, so fly-proxy stops
 *    sending new connections here and the reconnects land on the sibling.
 *    `/up` (the external monitor) deliberately does NOT flip: a deploy is
 *    not an incident. See `services/readiness.ts`.
 *  - the sockets are closed with 1001 in small batches with a little
 *    jitter between them, so the sibling sees a ramp of reconnects instead
 *    of every client at once. The address limiter in `ws/index.ts` was
 *    measured at ~300 simultaneous joiners; the pool and Clerk verification
 *    prefer the ramp long before that.
 *
 * Budget: `fly.toml` gives the process `kill_timeout` seconds (30) before
 * SIGKILL. Six hundred sockets (the proxy's hard limit) at fifty per
 * hundred milliseconds is about a second and a half, plus the two-second
 * settle for the check to turn red: well inside it, with the bus and pool
 * still to close after. `DRAIN_DEADLINE_MS` is the belt on top of the
 * braces: whatever is still open then is closed in one go, because a
 * SIGKILL closes it far less politely.
 */

/** How long to let `/health` be red before the first socket is closed. */
export const DRAIN_SETTLE_MS = 2_000;
/** Sockets closed per batch. */
export const DRAIN_BATCH_SIZE = 50;
/** Pause between batches, before jitter. */
export const DRAIN_BATCH_INTERVAL_MS = 100;
/** Random extra pause per batch, so two draining machines never stay in step. */
export const DRAIN_BATCH_JITTER_MS = 50;
/** The whole socket drain must be over by this; the rest is closed at once. */
export const DRAIN_DEADLINE_MS = 10_000;

/**
 * Sockets closed per second during a drain, by default. Each close is a
 * reconnect on the sibling a moment later (the client spreads its first
 * attempt over 0.5 to 4 s, `client/src/lib/reconnect-jitter.ts`), and each
 * reconnect is an `auth` with its catch-up queries. The fixed 50 per 100 ms
 * above meant 400 a second: a 143-socket container emptied in a third of a
 * second, so the sibling's whole herd arrived inside the client's jitter
 * window alone. 100 a second spreads the same container over 1.4 s on top of
 * that window. A container big enough to need more than
 * {@link DRAIN_SPREAD_CEILING_FRACTION} of the deadline at this rate goes
 * faster instead, so the deadline still bounds the drain.
 */
export const DEFAULT_DRAIN_RATE_PER_SECOND = 100;
/** Never plan a drain longer than this share of `DRAIN_DEADLINE_MS`. */
export const DRAIN_SPREAD_CEILING_FRACTION = 0.6;

/**
 * `DRAIN_RATE_PER_SECOND`, read at drain time. `0` is the rollback to the
 * fixed 50-per-batch drain this file always had.
 */
export function resolveDrainRatePerSecond(
  raw: string | undefined = process.env.DRAIN_RATE_PER_SECOND,
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DRAIN_RATE_PER_SECOND;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DRAIN_RATE_PER_SECOND;
}

/**
 * Batch size and spacing for draining `total` sockets at `ratePerSecond`.
 * Pure, so the arithmetic is what is tested. A rate of 0 answers the fixed
 * constants above, unchanged.
 */
export function drainPlan(
  total: number,
  ratePerSecond: number = resolveDrainRatePerSecond(),
  deadlineMs: number = DRAIN_DEADLINE_MS,
): { batchSize: number; intervalMs: number; ratePerSecond: number } {
  if (ratePerSecond <= 0) {
    return {
      batchSize: DRAIN_BATCH_SIZE,
      intervalMs: DRAIN_BATCH_INTERVAL_MS,
      ratePerSecond: (DRAIN_BATCH_SIZE * 1000) / DRAIN_BATCH_INTERVAL_MS,
    };
  }
  // The jitter adds a quarter of an interval on average, so plan against it.
  const effectiveIntervalMs = DRAIN_BATCH_INTERVAL_MS + DRAIN_BATCH_JITTER_MS / 2;
  const ceilingMs = deadlineMs * DRAIN_SPREAD_CEILING_FRACTION;
  const neededRate = (total * 1000) / Math.max(1, ceilingMs);
  const rate = Math.max(ratePerSecond, neededRate);
  const perInterval = (rate * effectiveIntervalMs) / 1000;
  if (perInterval >= 1) {
    return {
      batchSize: Math.round(perInterval),
      intervalMs: DRAIN_BATCH_INTERVAL_MS,
      ratePerSecond: rate,
    };
  }
  // Below one socket per interval: one at a time, further apart, so a low
  // rate is the rate asked for rather than about eight a second.
  return {
    batchSize: 1,
    intervalMs: Math.max(
      DRAIN_BATCH_INTERVAL_MS,
      Math.round(1000 / rate - DRAIN_BATCH_JITTER_MS / 2),
    ),
    ratePerSecond: rate,
  };
}

let draining = false;

/** Flip the flag; `/health` answers 503 from the next request on. */
export function beginDrain(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/** Test hook. */
export function resetDrainForTests(): void {
  draining = false;
}

export interface Closable {
  close(code: number, reason: string): void;
}

export interface DrainOptions {
  batchSize?: number;
  intervalMs?: number;
  jitterMs?: number;
  deadlineMs?: number;
  /** Uniform in [0, 1). Injectable so the jitter is testable. */
  random?: () => number;
  /** Called once per batch, with the batch's size, after it was closed. */
  onBatch?: (closed: number, remaining: number) => void;
}

export const GOING_AWAY = 1001;
export const GOING_AWAY_REASON = "Server shutting down";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Close every socket with 1001, `batchSize` at a time, `intervalMs` plus up
 * to `jitterMs` apart. Resolves when the last one has been told. A socket
 * that throws on close is skipped; it is going away regardless.
 *
 * The iterable is snapshotted first: `wss.clients` is a live Set and a
 * client that reconnects to *this* machine mid-drain (the proxy has not yet
 * seen the red check) must not be drained twice, nor keep the loop alive.
 */
export async function closeSocketsInBatches(
  sockets: Iterable<Closable>,
  options: DrainOptions = {},
): Promise<number> {
  const batchSize = Math.max(1, options.batchSize ?? DRAIN_BATCH_SIZE);
  const intervalMs = options.intervalMs ?? DRAIN_BATCH_INTERVAL_MS;
  const jitterMs = options.jitterMs ?? DRAIN_BATCH_JITTER_MS;
  const deadlineMs = options.deadlineMs ?? DRAIN_DEADLINE_MS;
  const random = options.random ?? Math.random;

  const pending = [...sockets];
  const startedAt = Date.now();
  let closed = 0;

  const closeOne = (socket: Closable) => {
    try {
      socket.close(GOING_AWAY, GOING_AWAY_REASON);
    } catch {
      // Already gone, or half-open: nothing to be polite about.
    }
    closed += 1;
  };

  while (pending.length > 0) {
    const overBudget = Date.now() - startedAt >= deadlineMs;
    const take = overBudget ? pending.length : batchSize;
    const batch = pending.splice(0, take);
    for (const socket of batch) {
      closeOne(socket);
    }
    options.onBatch?.(batch.length, pending.length);
    if (pending.length === 0) {
      break;
    }
    await sleep(intervalMs + Math.floor(random() * jitterMs));
  }
  return closed;
}

export interface HealthVerdict {
  status: 200 | 503;
  body: { ok: boolean; version?: string; error?: string };
}

/**
 * What `GET /health` answers — A3.1 of `docs/plans/ALWAYS_ON.md`.
 *
 * PROCESS LIVENESS ONLY, as of 2026-09-13. This used to run `SELECT 1` and
 * report the database's health alongside the process's; on 2026-09-12 the
 * database collapsed, the pool saturated, `/health` failed with it, and Fly
 * stopped routing to the only machine — taking WebSockets, the HLS playlist
 * proxy and every cached read down with it, none of which needed Postgres at
 * that instant. The database's health now belongs entirely to `/ready`
 * (`services/ready.ts`), which external monitors poll and which is
 * deliberately NOT what `fly.toml` or the Docker healthcheck route on
 * (`tools/api-host/compose.yaml`'s comment says the same). A DB-dependent
 * HTTP route answers its own 503 instead — see `DatabaseUnavailableError`
 * in `db.ts`.
 *
 * `isListening` names the one thing this function cannot verify on its own:
 * that the HTTP server this handler is attached to is actually the one
 * accepting connections. In practice a request cannot reach this handler at
 * all unless that is already true, so the parameter mostly documents the
 * claim and gives a test something to flip; pass `httpServer.listening`.
 *
 * `draining` wins over everything else: a process on its way out must read
 * as unhealthy the moment `beginDrain()` runs, so fly-proxy (or the Vultr
 * box's Caddy) stops sending it new connections and the reconnects land on
 * whatever machine is staying up.
 */
export function healthVerdict(
  isListening: boolean,
  version: string = process.env.APP_VERSION ?? "dev",
): HealthVerdict {
  if (draining) {
    return { status: 503, body: { ok: false, error: "draining" } };
  }
  if (!isListening) {
    return { status: 503, body: { ok: false, error: "not listening" } };
  }
  return { status: 200, body: { ok: true, version } };
}

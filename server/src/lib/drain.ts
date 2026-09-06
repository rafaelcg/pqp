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
 * What `GET /health` answers. Draining wins over the database probe: a
 * process on its way out must read as unhealthy even while its pool is
 * fine, or the proxy keeps sending it people it is about to disconnect.
 * The probe is skipped while draining so the pool, which may already be
 * closing, is not touched.
 */
export async function healthVerdict(
  probe: () => Promise<unknown>,
  version: string = process.env.APP_VERSION ?? "dev",
): Promise<HealthVerdict> {
  if (draining) {
    return { status: 503, body: { ok: false, error: "draining" } };
  }
  try {
    await probe();
    return { status: 200, body: { ok: true, version } };
  } catch {
    return { status: 503, body: { ok: false, error: "database unavailable" } };
  }
}

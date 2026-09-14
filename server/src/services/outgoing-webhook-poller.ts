import pg from "pg";
import { pgSslConfig } from "../db.js";

/**
 * Adaptive polling + NOTIFY wake for the outgoing webhook outbox.
 *
 * WHY. The 2026-09-13 Vultr cutover's 16.5h query stats showed 28.6k calls
 * to the delivery claim query (`deliverDueOutgoingWebhooks`, in
 * `outgoing-webhooks.ts`) returning 0 rows — a fixed 2s poll firing whether
 * or not there was anything to do. `enqueueOutgoingWebhookDeliveries`
 * already kicks a delivery attempt from the SAME process the moment a row
 * lands (see its call there), so the fixed interval's only real job is
 * retries, reclaiming a `delivering` row whose owner died mid-attempt, and
 * covering a split API/worker deployment (`WORKER_MODE`) where the process
 * that enqueues is not the one running this loop. None of that needs a 2s
 * cadence once the outbox has been empty for a while.
 *
 * WHAT THIS DOES. Ticks every `OUTGOING_WEBHOOK_POLL_MIN_MS` as long as a
 * tick finds work, doubling the wait after every empty tick up to
 * `OUTGOING_WEBHOOK_POLL_MAX_MS`. A dedicated Postgres LISTEN connection
 * wakes the poller immediately on a NOTIFY from *any* process (including a
 * separate worker) and resets the backoff, rather than leaving that process
 * to wait out whatever its current idle interval happens to be. A NOTIFY
 * that lands while a tick is already running is not dropped: it sets a
 * pending-wake flag that forces an immediate re-tick at the fast interval
 * once the in-flight one finishes, because that tick's own claim query may
 * already have run before the row the NOTIFY is about was committed.
 *
 * NOT THE CLUSTER BUS. `outgoing-webhooks.ts` already says why delivery
 * itself lives in Postgres rather than the cluster bus ("CLUSTER_BUS is the
 * wrong layer: it is ephemeral WS fan-out and dies with the process"), and
 * the same reasoning rules it out for the wake signal: `CLUSTER_BUS` is off
 * by default (CLAUDE.md — one machine in production today) and this has to
 * behave identically with it off. A second, dedicated LISTEN connection
 * costs one idle socket and works on every deployment shape, on or off.
 *
 * SAME BEHAVIOUR ON ONE MACHINE. The default deployment already gets
 * near-instant delivery from the in-process kick on enqueue (see
 * `outgoing-webhooks.ts`); this module only changes how often the *idle*
 * outbox gets polled between real events, never how fast a real enqueue is
 * served.
 *
 * ONE ACCEPTED GAP. A row becoming due for RETRY (its backoff elapsing) or a
 * `delivering` row's lease expiring emits no NOTIFY — only a fresh enqueue
 * does — so if either happens right after an empty tick, this waits out the
 * rest of that tick's backoff window (up to 30s) rather than firing right on
 * the deadline. This is the same 30s ceiling the task this module was built
 * for explicitly asked for ("backing off to 30s when idle"); a deadline-aware
 * timer that schedules itself against the next row's actual due time would
 * close it, and is deliberately left for a follow-up rather than folded in
 * here.
 *
 * STATE IDENTITY. Every async function below takes the specific
 * `PollerState` it started with as a parameter and checks `isActive`
 * (identity, not just `.stopped`) before touching anything mutable. A bare
 * `!state.stopped` check on the shared module-level `state` variable is not
 * enough: `stop()` followed by a fresh `start()` while an old tick or LISTEN
 * connect was still in flight would let that old continuation run its
 * checks against the NEW poller's (unstopped) state and mutate it — doubling
 * its interval, replacing its `pg.Client` without closing the old one, or
 * scheduling a second concurrent tick loop. Comparing against the captured
 * instance closes that window regardless of how the two overlap in time.
 */

export const OUTGOING_WEBHOOK_POLL_MIN_MS = 2_000;
export const OUTGOING_WEBHOOK_POLL_MAX_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

/** Not the cluster bus's channel (`pqp_cluster` in `lib/bus-postgres.ts`) —
 *  see the module comment above for why this stays a dedicated channel. */
export const OUTGOING_WEBHOOK_NOTIFY_CHANNEL = "pqp_outgoing_webhook_due";

const LISTEN_RECONNECT_MIN_MS = 1_000;
const LISTEN_RECONNECT_MAX_MS = 30_000;

type DeliverFn = () => Promise<number>;

interface PollerState {
  deliver: DeliverFn;
  timer: ReturnType<typeof setTimeout> | null;
  intervalMs: number;
  stopped: boolean;
  ticking: boolean;
  /** Set when a NOTIFY (or another wake) arrives while `ticking` is true —
   *  see the module comment's "WHAT THIS DOES" paragraph. */
  wakeRequested: boolean;
  listenClient: pg.Client | null;
  listenReconnectMs: number;
  listenReconnectTimer: ReturnType<typeof setTimeout> | null;
}

let state: PollerState | null = null;

/** True only for the specific instance that is still the live, running
 *  poller — see the module comment's "STATE IDENTITY" paragraph. */
function isActive(s: PollerState): boolean {
  return state === s && !s.stopped;
}

function scheduleTick(s: PollerState): void {
  if (!isActive(s)) {
    return;
  }
  if (s.timer) {
    clearTimeout(s.timer);
  }
  const timer = setTimeout(() => void runTick(s), s.intervalMs);
  timer.unref?.();
  s.timer = timer;
}

async function runTick(s: PollerState): Promise<void> {
  if (!isActive(s)) {
    return;
  }
  s.timer = null;
  s.ticking = true;
  let delivered = 0;
  try {
    delivered = await s.deliver();
  } catch (error) {
    console.error("[outgoing-webhooks] poll failed:", error);
  }
  if (!isActive(s)) {
    return;
  }
  s.ticking = false;
  if (s.wakeRequested) {
    // A wake arrived mid-tick: the claim query above may have run before
    // the row it is about was committed, so treat this exactly like a fresh
    // wake rather than trusting this tick's (possibly stale) `delivered`.
    s.wakeRequested = false;
    s.intervalMs = OUTGOING_WEBHOOK_POLL_MIN_MS;
    scheduleTick(s);
    return;
  }
  s.intervalMs =
    delivered > 0
      ? OUTGOING_WEBHOOK_POLL_MIN_MS
      : Math.min(s.intervalMs * BACKOFF_MULTIPLIER, OUTGOING_WEBHOOK_POLL_MAX_MS);
  scheduleTick(s);
}

/**
 * A NOTIFY (or a caller that wants a guaranteed fast retry right now) wakes
 * the poller: run a tick immediately, ignoring however long is left on the
 * current wait, and reset the backoff to the fast interval so a burst of
 * enqueues keeps ticking fast rather than backing off again on the very
 * next — now empty — poll. Arriving mid-tick, it is recorded rather than
 * dropped (see `wakeRequested` above).
 */
function wake(s: PollerState): void {
  if (!isActive(s)) {
    return;
  }
  if (s.ticking) {
    s.wakeRequested = true;
    return;
  }
  s.intervalMs = OUTGOING_WEBHOOK_POLL_MIN_MS;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  void runTick(s);
}

function teardownListenClient(s: PollerState): void {
  if (!s.listenClient) {
    return;
  }
  const client = s.listenClient;
  s.listenClient = null;
  client.removeAllListeners();
  void client.end().catch(() => {});
}

function scheduleListenReconnect(s: PollerState): void {
  if (!isActive(s)) {
    return;
  }
  teardownListenClient(s);
  if (s.listenReconnectTimer) {
    return;
  }
  const wait = s.listenReconnectMs;
  s.listenReconnectMs = Math.min(s.listenReconnectMs * 2, LISTEN_RECONNECT_MAX_MS);
  const timer = setTimeout(() => {
    if (!isActive(s)) {
      return;
    }
    s.listenReconnectTimer = null;
    void connectListener(s);
  }, wait);
  timer.unref?.();
  s.listenReconnectTimer = timer;
}

async function connectListener(s: PollerState): Promise<void> {
  if (!isActive(s)) {
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // No database configured — some unit-test environments run the poller
    // with a fake `deliver`. It still runs on its plain interval, just
    // without the NOTIFY fast path.
    return;
  }
  const client = new pg.Client({ connectionString, ...pgSslConfig() });
  client.on("error", (error) => {
    console.error("[outgoing-webhooks] listen connection error:", error);
    scheduleListenReconnect(s);
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${OUTGOING_WEBHOOK_NOTIFY_CHANNEL}`);
  } catch (error) {
    console.error("[outgoing-webhooks] listen connect failed:", error);
    await client.end().catch(() => {});
    scheduleListenReconnect(s);
    return;
  }
  client.on("notification", (msg) => {
    if (msg.channel === OUTGOING_WEBHOOK_NOTIFY_CHANNEL) {
      wake(s);
    }
  });
  if (!isActive(s)) {
    // Stopped (or replaced by a newer poller) while `connect`/`LISTEN` was
    // in flight: this client belongs to no one and must be closed, not
    // handed to `s` or left to leak.
    await client.end().catch(() => {});
    return;
  }
  s.listenClient = client;
  s.listenReconnectMs = LISTEN_RECONNECT_MIN_MS;
}

/**
 * Start the adaptive poller. Idempotent: a second call while one is already
 * running returns a stop handle for that same instance rather than starting
 * a second one racing it.
 */
export function startOutgoingWebhookPoller(deliver: DeliverFn): {
  stop(): void;
} {
  if (state && !state.stopped) {
    return { stop: stopOutgoingWebhookPoller };
  }
  const s: PollerState = {
    deliver,
    timer: null,
    intervalMs: OUTGOING_WEBHOOK_POLL_MIN_MS,
    stopped: false,
    ticking: false,
    wakeRequested: false,
    listenClient: null,
    listenReconnectMs: LISTEN_RECONNECT_MIN_MS,
    listenReconnectTimer: null,
  };
  state = s;
  scheduleTick(s);
  void connectListener(s);
  return { stop: stopOutgoingWebhookPoller };
}

export function stopOutgoingWebhookPoller(): void {
  if (!state) {
    return;
  }
  const s = state;
  s.stopped = true;
  // Cleared before teardown, not after: `isActive` (and therefore every
  // guard above) must already see this instance as inactive the moment a
  // synchronous continuation of `teardownListenClient` or a timer callback
  // could otherwise run.
  state = null;
  if (s.timer) {
    clearTimeout(s.timer);
  }
  if (s.listenReconnectTimer) {
    clearTimeout(s.listenReconnectTimer);
  }
  teardownListenClient(s);
}

/**
 * Ping every process LISTENing on the outbox channel. Call after inserting a
 * new `pending` delivery row. Safe with no poller running anywhere (NOTIFY
 * with no listeners is a no-op in Postgres) and swallows its own failure —
 * a missed wake costs at most one extra backoff step before the next poll,
 * never a stuck delivery, because the interval loop still reaches every row
 * on its own.
 */
export async function notifyOutgoingWebhookEnqueued(pool: {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  try {
    await pool.query(`SELECT pg_notify($1, '')`, [
      OUTGOING_WEBHOOK_NOTIFY_CHANNEL,
    ]);
  } catch (error) {
    console.error("[outgoing-webhooks] notify failed:", error);
  }
}

/** Test seam: trigger the same wake a real NOTIFY would, without a
 *  Postgres LISTEN connection. No-op with no poller running. */
export function wakeOutgoingWebhookPollerForTests(): void {
  if (state) {
    wake(state);
  }
}

/** Test seam. */
export function outgoingWebhookPollerSnapshotForTests(): {
  intervalMs: number;
  stopped: boolean;
  listening: boolean;
  wakeRequested: boolean;
} | null {
  if (!state) {
    return null;
  }
  return {
    intervalMs: state.intervalMs,
    stopped: state.stopped,
    listening: state.listenClient !== null,
    wakeRequested: state.wakeRequested,
  };
}

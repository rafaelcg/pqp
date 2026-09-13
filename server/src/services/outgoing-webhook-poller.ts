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
 * to wait out whatever its current idle interval happens to be.
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
  listenClient: pg.Client | null;
  listenReconnectMs: number;
  listenReconnectTimer: ReturnType<typeof setTimeout> | null;
}

let state: PollerState | null = null;

function scheduleTick(): void {
  if (!state || state.stopped) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  const timer = setTimeout(() => void runTick(), state.intervalMs);
  timer.unref?.();
  state.timer = timer;
}

async function runTick(): Promise<void> {
  if (!state || state.stopped) {
    return;
  }
  state.timer = null;
  state.ticking = true;
  let delivered = 0;
  try {
    delivered = await state.deliver();
  } catch (error) {
    console.error("[outgoing-webhooks] poll failed:", error);
  }
  if (!state || state.stopped) {
    return;
  }
  state.ticking = false;
  state.intervalMs =
    delivered > 0
      ? OUTGOING_WEBHOOK_POLL_MIN_MS
      : Math.min(state.intervalMs * BACKOFF_MULTIPLIER, OUTGOING_WEBHOOK_POLL_MAX_MS);
  scheduleTick();
}

/**
 * A NOTIFY (or a caller that wants a guaranteed fast retry right now) wakes
 * the poller: run a tick immediately, ignoring however long is left on the
 * current wait, and reset the backoff to the fast interval so a burst of
 * enqueues keeps ticking fast rather than backing off again on the very
 * next — now empty — poll.
 */
function wake(): void {
  if (!state || state.stopped || state.ticking) {
    return;
  }
  state.intervalMs = OUTGOING_WEBHOOK_POLL_MIN_MS;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  void runTick();
}

function teardownListenClient(): void {
  if (!state?.listenClient) {
    return;
  }
  const client = state.listenClient;
  state.listenClient = null;
  client.removeAllListeners();
  void client.end().catch(() => {});
}

function scheduleListenReconnect(): void {
  if (!state || state.stopped) {
    return;
  }
  teardownListenClient();
  if (state.listenReconnectTimer) {
    return;
  }
  const wait = state.listenReconnectMs;
  state.listenReconnectMs = Math.min(
    state.listenReconnectMs * 2,
    LISTEN_RECONNECT_MAX_MS,
  );
  const timer = setTimeout(() => {
    if (!state) {
      return;
    }
    state.listenReconnectTimer = null;
    void connectListener();
  }, wait);
  timer.unref?.();
  state.listenReconnectTimer = timer;
}

async function connectListener(): Promise<void> {
  if (!state || state.stopped) {
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
    scheduleListenReconnect();
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${OUTGOING_WEBHOOK_NOTIFY_CHANNEL}`);
  } catch (error) {
    console.error("[outgoing-webhooks] listen connect failed:", error);
    await client.end().catch(() => {});
    scheduleListenReconnect();
    return;
  }
  client.on("notification", (msg) => {
    if (msg.channel === OUTGOING_WEBHOOK_NOTIFY_CHANNEL) {
      wake();
    }
  });
  if (!state || state.stopped) {
    await client.end().catch(() => {});
    return;
  }
  state.listenClient = client;
  state.listenReconnectMs = LISTEN_RECONNECT_MIN_MS;
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
  state = {
    deliver,
    timer: null,
    intervalMs: OUTGOING_WEBHOOK_POLL_MIN_MS,
    stopped: false,
    ticking: false,
    listenClient: null,
    listenReconnectMs: LISTEN_RECONNECT_MIN_MS,
    listenReconnectTimer: null,
  };
  scheduleTick();
  void connectListener();
  return { stop: stopOutgoingWebhookPoller };
}

export function stopOutgoingWebhookPoller(): void {
  if (!state) {
    return;
  }
  state.stopped = true;
  if (state.timer) {
    clearTimeout(state.timer);
  }
  if (state.listenReconnectTimer) {
    clearTimeout(state.listenReconnectTimer);
  }
  teardownListenClient();
  state = null;
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

/** Test seam. */
export function outgoingWebhookPollerSnapshotForTests(): {
  intervalMs: number;
  stopped: boolean;
  listening: boolean;
} | null {
  if (!state) {
    return null;
  }
  return {
    intervalMs: state.intervalMs,
    stopped: state.stopped,
    listening: state.listenClient !== null,
  };
}

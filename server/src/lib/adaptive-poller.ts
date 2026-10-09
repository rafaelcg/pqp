import pg from "pg";
import { pgSslConfig } from "../db.js";

/**
 * A poll loop that is fast while there is work and backs off while there is
 * none, woken at once by a Postgres NOTIFY from any process.
 *
 * The same design as `services/outgoing-webhook-poller.ts` (read its module
 * comment for the reasoning, the NOTIFY-mid-tick rule and the "state
 * identity" rule), as a factory so a second queue does not need a second copy
 * of a singleton. The webhook poller is left as it is: it is tested, deployed
 * and has nothing to gain from a move.
 *
 *   * A tick that did work schedules the next one at `minMs`; an empty tick
 *     doubles the wait, up to `maxMs`.
 *   * A NOTIFY on `channel` runs a tick now and resets the backoff. One that
 *     lands DURING a tick is remembered and forces another tick right after,
 *     because the running tick's claim may have been read before the row the
 *     NOTIFY is about was committed.
 *   * A dedicated LISTEN connection, not the cluster bus: the bus is off on a
 *     single machine and must not be what makes a queue fast.
 *
 * NOTIFY is transactional in Postgres, which is what lets the enqueue send it
 * from inside the message transaction: it is delivered at COMMIT, never for a
 * row that rolled back, and costs nothing on the network before then.
 */

export interface AdaptivePollerOptions {
  /** For logs. */
  name: string;
  /** The LISTEN channel. Must be a plain identifier. */
  channel: string;
  minMs: number;
  maxMs: number;
  /** One tick: the number of jobs it handled. 0 means "nothing to do". */
  run: () => Promise<number>;
}

export interface AdaptivePoller {
  stop(): void;
  /** What a NOTIFY does, for a caller in the same process (and tests). */
  wake(): void;
  snapshot(): { intervalMs: number; listening: boolean; stopped: boolean };
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function startAdaptivePoller(options: AdaptivePollerOptions): AdaptivePoller {
  if (!/^[a-z_][a-z0-9_]*$/.test(options.channel)) {
    throw new Error(`Bad LISTEN channel ${options.channel}`);
  }
  let stopped = false;
  let ticking = false;
  let wakeRequested = false;
  let intervalMs = options.minMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let listenClient: pg.Client | null = null;
  let reconnectMs = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    timer = null;
    ticking = true;
    let handled = 0;
    try {
      handled = await options.run();
    } catch (error) {
      console.error(`[${options.name}] poll failed:`, error);
    }
    ticking = false;
    if (stopped) return;
    if (wakeRequested) {
      wakeRequested = false;
      intervalMs = options.minMs;
      schedule();
      return;
    }
    intervalMs = handled > 0 ? options.minMs : Math.min(intervalMs * 2, options.maxMs);
    schedule();
  };

  const wake = () => {
    if (stopped) return;
    if (ticking) {
      wakeRequested = true;
      return;
    }
    intervalMs = options.minMs;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void tick();
  };

  const teardownListen = () => {
    const client = listenClient;
    listenClient = null;
    if (client) {
      client.removeAllListeners();
      void client.end().catch(() => undefined);
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    teardownListen();
    if (reconnectTimer) return;
    const wait = reconnectMs;
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, wait);
    reconnectTimer.unref?.();
  };

  const connect = async () => {
    if (stopped) return;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) return;
    const client = new pg.Client({ connectionString, ...pgSslConfig() });
    client.on("error", (error) => {
      console.error(`[${options.name}] listen connection error:`, error.message);
      scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${options.channel}`);
    } catch (error) {
      console.error(`[${options.name}] listen connect failed:`, (error as Error).message);
      await client.end().catch(() => undefined);
      scheduleReconnect();
      return;
    }
    if (stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    client.on("notification", (message) => {
      if (message.channel === options.channel) wake();
    });
    listenClient = client;
    reconnectMs = RECONNECT_MIN_MS;
    // A row enqueued while this connection was down sent its NOTIFY to
    // nobody; look now rather than at the end of whatever the backoff is.
    wake();
  };

  schedule();
  void connect();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      teardownListen();
    },
    wake,
    snapshot: () => ({ intervalMs, listening: listenClient !== null, stopped }),
  };
}

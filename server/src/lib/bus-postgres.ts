import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgSslConfig } from "../db.js";
import { INSTANCE_ID, type BusFrame, type BusTransport } from "./bus.js";
import { logEvent } from "./log.js";

/**
 * Cluster bus over Postgres LISTEN/NOTIFY.
 *
 * WHY POSTGRES AND NOT REDIS. Postgres is already a hard dependency, already
 * has credentials, backups, TLS and monitoring, and already sits in the same
 * region as the app. Redis would be a second thing to run, pay for and page on,
 * for a payload volume this app does not yet produce. The abstraction in bus.ts
 * is what keeps that reversible: swapping this file for a Redis transport
 * changes nothing above it.
 *
 * WHAT POSTGRES COSTS. Three real constraints, each handled below:
 *
 * 1. THE 8000-BYTE PAYLOAD CAP. `NOTIFY` refuses a payload of 8000 bytes or
 *    more, and our frames genuinely exceed it: a message body is 4000 *chars*
 *    (up to ~16KB of UTF-8 before JSON escaping), a webhook message may carry
 *    10 embeds of up to ~38KB each, and an eviction scope can list every member
 *    of a channel. Anything over the inline budget is written to
 *    `cluster_bus_payloads` in the same statement as the NOTIFY and fetched by
 *    reference on the other side. Dropping oversize frames instead would be the
 *    worst of both worlds — a cluster that works until somebody posts a long
 *    message.
 *
 * 2. ONE SESSION, OUTSIDE THE POOL. A LISTENing connection must be long-lived
 *    and cannot be handed back to the pool, so this owns a `pg.Client` of its
 *    own. That same client also does the publishing, which is not laziness: it
 *    makes ordering trivially FIFO (node-postgres serialises queries on one
 *    connection) and leaves exactly one reconnect path to get right.
 *
 * 3. NOTIFY IS TRANSACTIONAL AND SELF-DELIVERING. Notifications fire at commit
 *    (these run in autocommit, so: immediately) and Postgres delivers them back
 *    to the sending session too — which is why `bus.ts` drops frames whose
 *    origin is this instance.
 *
 * KNOWN CEILING. Every frame is a round trip on a single connection through
 * Postgres' global notify queue, so this transport is worth a few thousand
 * frames a second, not tens of thousands. Measured chat throughput today is
 * ~180 msg/s (docs/LAUNCH.md §T1), so the headroom is roughly an order of
 * magnitude. Past that, replace this file with Redis rather than tuning it.
 */

/** One channel for every topic: LISTEN is per session, not per subject. */
const NOTIFY_CHANNEL = "pqp_cluster";

/**
 * Postgres' limit is 8000 bytes for the payload; this leaves room for the
 * multi-byte characters a `Buffer.byteLength` check already counts and for any
 * future envelope field.
 */
const MAX_INLINE_BYTES = 7000;

/** Spilled rows are read within milliseconds; this is pure crash slack. */
const SPILL_RETENTION = "2 minutes";
const SPILL_SWEEP_INTERVAL_MS = 60_000;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

interface SpillReference {
  origin: string;
  /** Row id in `cluster_bus_payloads` holding the real frame. */
  spill: string;
}

function isSpillReference(value: unknown): value is SpillReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SpillReference).spill === "string"
  );
}

function isFrame(value: unknown): value is BusFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BusFrame).origin === "string" &&
    typeof (value as BusFrame).topic === "string"
  );
}

export interface PostgresBusTransport extends BusTransport {
  /** Resolves once the first LISTEN is active. Boot logging and tests use it. */
  whenConnected(): Promise<void>;
}

export function createPostgresBusTransport(
  connectionString = process.env.DATABASE_URL,
): PostgresBusTransport {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the Postgres cluster bus");
  }

  let client: pg.Client | null = null;
  let handler: ((frame: BusFrame) => void) | null = null;
  let closed = false;
  let connecting = false;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Frames dropped because the transport was disconnected. Not buffered: a
   * queue that grows while Postgres is unreachable is a memory leak dressed as
   * reliability, and a presence frame delivered a minute late is worse than not
   * delivered at all.
   */
  let droppedWhileDown = 0;
  let connectedOnce: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    connectedOnce = resolve;
  });

  /**
   * Delivery is serialised through this chain because a spilled frame needs a
   * SELECT before it can be dispatched, and an inline frame published after it
   * would otherwise overtake it — reordering a `message-broadcast` behind its
   * own `message-update`.
   */
  let dispatchChain: Promise<void> = Promise.resolve();

  function scheduleReconnect(from: pg.Client | null): void {
    if (closed || reconnectTimer) {
      return;
    }
    // Ignore the death of a client we already replaced.
    if (from && client && from !== client) {
      return;
    }
    client = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelay);
    reconnectTimer.unref?.();
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  async function connect(): Promise<void> {
    if (closed || connecting || client) {
      return;
    }
    connecting = true;
    const next = new pg.Client({ connectionString, ...pgSslConfig() });

    // Both of these fire for an idle connection dropped by the network or by a
    // Postgres restart. Without listeners, `error` on a pg.Client is an
    // unhandled exception — which is the failure mode that takes the whole
    // process (and every socket on it) down.
    next.on("error", (error: Error) => {
      logEvent("bus.error", { message: error.message });
      scheduleReconnect(next);
    });
    next.on("end", () => scheduleReconnect(next));
    next.on("notification", (message) => {
      if (message.channel === NOTIFY_CHANNEL && message.payload) {
        enqueue(message.payload);
      }
    });

    try {
      await next.connect();
      // Identifiers cannot be parameters; NOTIFY_CHANNEL is a constant.
      await next.query(`LISTEN ${NOTIFY_CHANNEL}`);
    } catch (error) {
      connecting = false;
      logEvent("bus.connectFailed", { message: (error as Error).message });
      await next.end().catch(() => {});
      scheduleReconnect(null);
      return;
    }

    connecting = false;
    if (closed) {
      await next.end().catch(() => {});
      return;
    }
    client = next;
    reconnectDelay = RECONNECT_MIN_MS;
    logEvent("bus.connected", {
      instance: INSTANCE_ID,
      droppedWhileDown: droppedWhileDown || undefined,
    });
    connectedOnce?.();
    connectedOnce = null;
  }

  function enqueue(payload: string): void {
    dispatchChain = dispatchChain
      .then(() => receive(payload))
      .catch((error) => {
        console.error("[bus] dispatch failed:", error);
      });
  }

  async function receive(payload: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Somebody else NOTIFYing our channel, or a frame from a future version
      // of the app. Neither is a reason to fall over.
      logEvent("bus.badFrame", { bytes: payload.length });
      return;
    }

    if (isSpillReference(parsed)) {
      const reference = parsed;
      // Skip the round trip for our own frames — `bus.ts` would drop them.
      if (reference.origin === INSTANCE_ID) {
        return;
      }
      const current = client;
      if (!current) {
        return;
      }
      const result = await current.query<{ payload: string }>(
        `SELECT payload FROM cluster_bus_payloads WHERE id = $1`,
        [reference.spill],
      );
      const row = result.rows[0];
      if (!row) {
        // Swept, or the publisher's transaction never landed. The frame is
        // ephemeral by construction, so losing it degrades presence/typing on
        // this instance and nothing else.
        logEvent("bus.spillMissing", { id: reference.spill });
        return;
      }
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        logEvent("bus.badSpill", { id: reference.spill });
        return;
      }
    }

    if (!isFrame(parsed)) {
      logEvent("bus.badFrame", { bytes: payload.length });
      return;
    }
    handler?.(parsed);
  }

  function onPublishError(error: Error): void {
    // A failed publish is one frame the rest of the cluster never sees. It must
    // not surface to the caller, which has already served its own sockets.
    logEvent("bus.publishFailed", { message: error.message });
  }

  const sweep = setInterval(() => {
    const current = client;
    if (!current) {
      return;
    }
    void current
      .query(
        `DELETE FROM cluster_bus_payloads
         WHERE created_at < NOW() - INTERVAL '${SPILL_RETENTION}'`,
      )
      .catch((error: Error) => {
        logEvent("bus.sweepFailed", { message: error.message });
      });
  }, SPILL_SWEEP_INTERVAL_MS);
  sweep.unref?.();

  void connect();

  return {
    name: "postgres",

    publish(frame) {
      const current = client;
      if (!current) {
        droppedWhileDown += 1;
        return;
      }
      const encoded = JSON.stringify(frame);
      if (Buffer.byteLength(encoded) <= MAX_INLINE_BYTES) {
        void current
          .query(`SELECT pg_notify($1, $2)`, [NOTIFY_CHANNEL, encoded])
          .catch(onPublishError);
        return;
      }
      // Oversize: park the frame and notify a reference to it. One statement,
      // so the row and the notification commit together — a notification whose
      // row is not yet visible would be a read of nothing.
      const id = randomUUID();
      void current
        .query(
          `WITH spilled AS (
             INSERT INTO cluster_bus_payloads (id, payload) VALUES ($1, $2)
           )
           SELECT pg_notify($3, $4)`,
          [
            id,
            encoded,
            NOTIFY_CHANNEL,
            JSON.stringify({ origin: frame.origin, spill: id }),
          ],
        )
        .catch(onPublishError);
    },

    onFrame(next) {
      handler = next;
    },

    whenConnected() {
      return ready;
    },

    async close() {
      closed = true;
      clearInterval(sweep);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = client;
      client = null;
      handler = null;
      await current?.end().catch(() => {});
    },
  };
}

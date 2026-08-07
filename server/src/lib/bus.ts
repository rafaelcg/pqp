import { randomUUID } from "node:crypto";

/**
 * The cluster bus — the seam that would let more than one server process serve
 * the same channel.
 *
 * Everything the realtime layer knows lives in process memory: `connections` /
 * `channelPresence` (ws/chat.ts), voice `peers` (ws/voice.ts), rate-limit
 * buckets (lib/rate-limit.ts). Two replicas do not fail loudly, they split the
 * userbase — two people in one channel, on different replicas, never see each
 * other's messages or presence. This module is where the parts that *can* be
 * shared get shared.
 *
 * DEFAULT IS OFF, AND OFF MEANS OFF. With no transport installed
 * `isBusEnabled()` is false, `publishToCluster` returns on its first line, and
 * every caller keeps taking exactly the code path it took before this file
 * existed. Callers are written to check `isBusEnabled()` *before* building a
 * payload, so a disabled bus costs one boolean read and allocates nothing.
 *
 * The bus carries ephemeral fan-out only — who is looking at a channel, what
 * was just said, who is typing. It is never the system of record: messages are
 * in Postgres and a client that missed a frame recovers by refetching history.
 * That is what makes "the transport is down" a degradation (back to
 * single-instance behaviour) rather than an outage, and why `publish` is
 * fire-and-forget with no delivery guarantee and no back-pressure onto the
 * caller.
 */

export interface BusFrame {
  /**
   * The instance that published this frame. THE LOOP GUARD DEPENDS ON THIS:
   * Postgres delivers a NOTIFY back to the session that sent it, so without
   * dropping our own origin every broadcast would be re-delivered to the
   * instance that just sent it — and any handler that re-published would spin
   * forever.
   */
  origin: string;
  topic: string;
  data: unknown;
}

export interface BusTransport {
  /** Short name for logs — "postgres", "memory". */
  readonly name: string;
  /**
   * Best-effort send. MUST NOT throw and MUST NOT return a promise the caller
   * has to await: publishing happens right after a message has already been
   * delivered to local sockets, and a slow or dead bus must never hold that up.
   */
  publish(frame: BusFrame): void;
  /** Installed once, by `setBusTransport`. */
  onFrame(handler: (frame: BusFrame) => void): void;
  close(): Promise<void>;
}

export type BusHandler = (data: unknown, origin: string) => void;

/**
 * Identity of this process for the lifetime of the process. Regenerated on
 * every boot on purpose: a restarted instance must not be mistaken for its
 * former self, or stale presence contributions published under the old id
 * would be treated as refreshed by the new one.
 */
export const INSTANCE_ID = randomUUID();

let transport: BusTransport | null = null;
const handlers = new Map<string, Set<BusHandler>>();

/**
 * Check this before building anything you intend to publish. It is the switch
 * that keeps the single-instance path byte-for-byte what it was.
 */
export function isBusEnabled(): boolean {
  return transport !== null;
}

/**
 * Fire-and-forget. Swallows transport failures by design: the local sockets
 * have already been served by the time anything is published here, so the worst
 * a broken bus can do is degrade this instance to single-instance behaviour.
 * Letting the error escape would instead break delivery to the clients that
 * *are* connected here.
 */
export function publishToCluster(topic: string, data: unknown): void {
  const current = transport;
  if (!current) {
    return;
  }
  try {
    current.publish({ origin: INSTANCE_ID, topic, data });
  } catch (error) {
    console.error(`[bus] ${current.name} publish to ${topic} failed:`, error);
  }
}

/**
 * Subscriptions are registered against this module rather than against a
 * transport, so they survive a transport being installed later (chat.ts
 * subscribes at import time; the transport is chosen at boot) or swapped in a
 * test.
 */
export function subscribeToCluster(topic: string, handler: BusHandler): void {
  const existing = handlers.get(topic);
  if (existing) {
    existing.add(handler);
    return;
  }
  handlers.set(topic, new Set([handler]));
}

function dispatch(frame: BusFrame): void {
  // The loop guard. Also the reason handlers never need to know whether a
  // frame is "ours": by the time one runs, it cannot be.
  if (frame.origin === INSTANCE_ID) {
    return;
  }
  const subscribers = handlers.get(frame.topic);
  if (!subscribers) {
    return;
  }
  for (const handler of subscribers) {
    // One handler throwing must not skip the others, and must not propagate
    // into the transport's connection handling.
    try {
      handler(frame.data, frame.origin);
    } catch (error) {
      console.error(`[bus] handler for ${frame.topic} failed:`, error);
    }
  }
}

/** Installs (or, with `null`, removes) the transport. Called once at boot. */
export function setBusTransport(next: BusTransport | null): void {
  transport = next;
  next?.onFrame(dispatch);
}

export async function closeBus(): Promise<void> {
  const current = transport;
  transport = null;
  await current?.close().catch((error) => {
    console.error("[bus] close failed:", error);
  });
}

/** Test seam: drop every subscription registered so far. */
export function resetBusSubscriptions(): void {
  handlers.clear();
}

/**
 * A bus that never leaves the process. Exists for tests, which run several
 * "instances" as separate module graphs over one shared hub — that is the only
 * way to exercise cross-instance delivery without two real servers.
 *
 * It deliberately delivers a frame back to its own publisher, because Postgres
 * LISTEN/NOTIFY does exactly that. A test double that quietly skipped the
 * publisher would hide the very bug the origin check exists to prevent.
 */
export interface MemoryBusHub {
  readonly listeners: Set<(frame: BusFrame) => void>;
}

export function createMemoryHub(): MemoryBusHub {
  return { listeners: new Set() };
}

export function createMemoryTransport(hub: MemoryBusHub): BusTransport {
  let handler: ((frame: BusFrame) => void) | null = null;
  const deliver = (frame: BusFrame) => handler?.(frame);
  hub.listeners.add(deliver);

  return {
    name: "memory",
    publish(frame) {
      // Snapshot: a handler may install or close a transport while delivering.
      for (const listener of [...hub.listeners]) {
        listener(frame);
      }
    },
    onFrame(next) {
      handler = next;
    },
    async close() {
      hub.listeners.delete(deliver);
      handler = null;
    },
  };
}

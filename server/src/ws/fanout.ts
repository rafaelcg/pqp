import type { WebSocket } from "ws";
import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import {
  noteSharedDeflateSkipped,
  SHARED_DEFLATE_MIN_RECIPIENTS,
  SharedDeflateBroadcast,
} from "../lib/ws-shared-deflate.js";
import { WS_PER_MESSAGE_DEFLATE } from "../lib/ws-compression.js";

/**
 * The three things every large-room fan-out on this process needs, kept in one
 * place so chat presence, typing and the voice roster cannot drift apart:
 *
 *  1. ENCODE ONCE. A frame going to N sockets is serialised to one Buffer and
 *     that Buffer is handed to every socket. `ws` writes a string by encoding
 *     it on the way out of each socket; a Buffer is written as-is. Sent with
 *     `binary: false` so the wire frame is still a text frame and every client
 *     (browser, iOS, Android) reads it exactly as before.
 *
 *  2. BACKPRESSURE. `ws` queues without bound. A socket on a bad link that is
 *     already holding a megabyte of unsent frames gains nothing from another
 *     roster it will only read late, and the process pays the serialisation,
 *     the copy and the memory for it anyway. Low-value frames (typing, presence
 *     and roster snapshots, which are all superseded by the next one of their
 *     kind) are dropped for such a socket; messages are never dropped here.
 *
 *  3. COALESCE. A burst of joins produces one roster, not ten. Each key (a
 *     channel id) gets a short timer; every request inside the window shares
 *     one send, and the send reads state at fire time, so the frame that goes
 *     out is the newest one. Callers still get a promise that resolves when
 *     their request has been served, which keeps the handler ordering the
 *     tests rely on.
 */

/** Serialise a server frame once, for however many sockets will receive it. */
export function encodeFrame(message: unknown): Buffer {
  return Buffer.from(JSON.stringify(message), "utf8");
}

const TEXT = { binary: false } as const;

/**
 * Bytes a socket may have queued before low-value frames stop being sent to
 * it. One megabyte is roughly a second of a saturated home uplink and far
 * more than any healthy client ever accumulates; a socket above it is either
 * on a dead link the heartbeat has not reaped yet or genuinely too slow to
 * follow the room, and either way the next snapshot will do.
 */
export const SEND_BACKPRESSURE_BYTES = 1024 * 1024;

let droppedFrames = 0;

/** Test / metrics seam: how many low-value frames were dropped since boot. */
export function droppedFrameCount(): number {
  return droppedFrames;
}

/** Sends an already-encoded frame. Never drops. */
export function sendEncoded(socket: WebSocket, frame: Buffer): void {
  if (socket.readyState === 1) {
    socket.send(frame, TEXT);
  }
}

/**
 * Sends an already-encoded frame unless the socket is over the backpressure
 * threshold, in which case the frame is dropped and `false` is returned. Only
 * for frames a later frame supersedes (typing, presence, roster).
 */
export function sendEncodedDroppable(socket: WebSocket, frame: Buffer): boolean {
  if (socket.readyState !== 1) {
    return false;
  }
  if (overBackpressure(socket)) {
    return false;
  }
  socket.send(frame, TEXT);
  return true;
}

/** True, and counted, when a droppable frame must be skipped for `socket`. */
function overBackpressure(socket: WebSocket): boolean {
  // Written as the original `>` test, not its `<=` complement, so a socket
  // whose `bufferedAmount` is not a number is served exactly as before.
  if (!(socket.bufferedAmount > SEND_BACKPRESSURE_BYTES)) {
    return false;
  }
  droppedFrames += 1;
  // Once per 1000 so a stuck socket cannot turn the log into the problem.
  if (droppedFrames % 1000 === 1) {
    logEvent("ws.backpressureDrop", {
      bufferedAmount: socket.bufferedAmount,
      dropped: droppedFrames,
    });
  }
  return true;
}

export interface BroadcastOptions {
  /**
   * Skip a socket over {@link SEND_BACKPRESSURE_BYTES} instead of queueing for
   * it, exactly as {@link sendEncodedDroppable}. Only for frames a later frame
   * supersedes (typing, presence and roster snapshots), never messages.
   */
  droppable?: boolean;
  /** Called for each socket the frame was written to, with its index. */
  onSent?: (socket: WebSocket, index: number) => void;
}

/**
 * THE fan-out: one already-encoded frame to every socket in `sockets`, in
 * order. Answers how many it was written to. Closed sockets are skipped, as
 * are, with `droppable`, sockets over the backpressure threshold.
 *
 * Every site that sends one identical payload to many sockets goes through
 * here, so that the runtime flag `ws_shared_deflate` can compress such a frame
 * ONCE (`lib/ws-shared-deflate.ts`) instead of once per socket, which is what
 * `ws` does. With the flag off, or the frame under the compression threshold,
 * or fewer than {@link SHARED_DEFLATE_MIN_RECIPIENTS} recipients, this is the
 * same `socket.send(frame, { binary: false })` per socket the callers made
 * before it existed, byte for byte.
 *
 * Per socket, the shared path is taken only when it is provably what `ws`
 * would have written (see that file); every other socket, including one whose
 * sender is busy compressing something else, is sent the ordinary way, so the
 * order of frames on any one socket never changes.
 */
export function broadcastEncoded(
  sockets: readonly WebSocket[],
  frame: Buffer,
  options: BroadcastOptions = {},
): number {
  const shared = sharedBroadcastFor(frame, sockets.length);
  let sent = 0;
  for (let index = 0; index < sockets.length; index += 1) {
    const socket = sockets[index]!;
    if (socket.readyState !== 1) {
      continue;
    }
    if (options.droppable && overBackpressure(socket)) {
      continue;
    }
    if (shared?.trySend(socket) !== "shared") {
      socket.send(frame, TEXT);
    }
    sent += 1;
    options.onSent?.(socket, index);
  }
  return sent;
}

function sharedBroadcastFor(
  frame: Buffer,
  recipients: number,
): SharedDeflateBroadcast | null {
  // Cheapest test first: almost every fan-out is a small frame (typing,
  // presence deltas), and those must not pay a flag read.
  if (frame.length < (WS_PER_MESSAGE_DEFLATE.threshold ?? 1024)) {
    return null;
  }
  if (!isEnabled("ws_shared_deflate")) {
    return null;
  }
  if (recipients < SHARED_DEFLATE_MIN_RECIPIENTS) {
    noteSharedDeflateSkipped("fewRecipients");
    return null;
  }
  return new SharedDeflateBroadcast(frame);
}

/**
 * How long a snapshot (viewer list, voice roster) waits for company before it
 * goes out, by the size of the thing it describes. A snapshot costs its size
 * times its audience, and both grow with the room, so the window grows with
 * it: a small room stays instant, a hundred-person room gets at most two
 * frames a second, which is still faster than anyone reads a badge.
 *
 * A short fixed window does nothing for the steady state, which is what a
 * big room actually is. Measured: 200 people, 28 roster requests a second
 * spread evenly, a 50 ms window still let ten frames a second through.
 */
export function coalesceWindowFor(size: number): number {
  if (size <= 20) {
    return 50;
  }
  if (size <= 100) {
    return 250;
  }
  return 500;
}

export interface Coalescer<K> {
  /**
   * Ask for `run(key)` to happen. Requests inside one window share a single
   * run; the returned promise resolves once that run has completed. Never
   * rejects: a failing run is logged by the caller's `run`.
   */
  request(key: K): Promise<void>;
  /** Pending keys, for tests. */
  pending(): number;
  /** Drop every pending window without running it. Tests and shutdown. */
  reset(): void;
}

interface Window {
  timer: NodeJS.Timeout | null;
  promise: Promise<void>;
  resolve: () => void;
}

let immediate = false;

/**
 * Test seam. Suites that fake timers (`vi.useFakeTimers`) freeze the window's
 * timer, and a handler awaiting its roster would wait forever. With this on,
 * a window fires on the next microtask instead: a synchronous burst still
 * folds into one send, and nothing waits on a clock that never ticks.
 */
export function setCoalesceImmediate(on: boolean): void {
  immediate = on;
}

/**
 * Per-key trailing debounce that also serialises runs per key: a run for a key
 * never overlaps a previous run for the same key, so an older snapshot can
 * never be delivered after a newer one, which is what keeps a roster
 * authoritative.
 *
 * `delayMs` of 0 still defers to a macrotask, which is enough to fold a
 * synchronous burst (one eviction removing twenty peers) into one send.
 */
export function createCoalescer<K>(
  delayMs: number | ((key: K) => number),
  run: (key: K) => Promise<void> | void,
): Coalescer<K> {
  const delayFor = typeof delayMs === "function" ? delayMs : () => delayMs;
  const windows = new Map<K, Window>();
  const inFlight = new Map<K, Promise<void>>();

  function fire(key: K, window: Window): void {
    if (windows.get(key) === window) {
      windows.delete(key);
    }
    const previous = inFlight.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => run(key))
      .catch((error: unknown) => {
        console.error("[ws] coalesced fan-out failed:", error);
      })
      .finally(() => {
        if (inFlight.get(key) === next) {
          inFlight.delete(key);
        }
        window.resolve();
      });
    inFlight.set(key, next);
  }

  return {
    request(key) {
      const existing = windows.get(key);
      if (existing) {
        return existing.promise;
      }
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      const window: Window = { promise, resolve, timer: null };
      if (immediate) {
        queueMicrotask(() => fire(key, window));
      } else {
        window.timer = setTimeout(() => fire(key, window), delayFor(key));
        window.timer.unref?.();
      }
      windows.set(key, window);
      return promise;
    },
    pending() {
      return windows.size;
    },
    reset() {
      for (const window of windows.values()) {
        if (window.timer) {
          clearTimeout(window.timer);
        }
        window.resolve();
      }
      windows.clear();
    },
  };
}

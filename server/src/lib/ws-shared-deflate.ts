import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";

import type { WebSocket } from "ws";

import { logEvent } from "./log.js";

/**
 * COMPRESS ONCE, WRITE TO MANY. The shared half of `broadcastEncoded` in
 * `ws/fanout.ts`, behind the runtime flag `ws_shared_deflate`.
 *
 * WHY. `ws` compresses per socket: one 92 KB roster to 1,000 sockets is 1,000
 * zlib runs of the same bytes, measured at about 406 ms of processor and about
 * 328 KB of memory per socket (the zlib context each socket keeps while its
 * frame is in flight). Compressing it once and writing the same bytes to every
 * socket measured 17.6 ms for the WHOLE fan-out (the one compression plus
 * 1,000 socket writes) and 24 KB per socket. `tools/ws-shared-deflate-bench`
 * reproduces both numbers.
 *
 * WHY THE SAME BYTES ARE VALID FOR EVERY SOCKET. A permessage-deflate message
 * (RFC 7692) is a raw DEFLATE stream ending on a sync flush, with the four
 * trailing bytes `00 00 ff ff` removed. Two things could tie a message to one
 * socket, and neither applies here:
 *
 *  1. THE RECEIVER'S WINDOW. A peer whose inflater keeps context takeover holds
 *     the previous messages in its sliding window, and a back-reference may
 *     reach into it. A stream from a FRESH deflate context never emits one: it
 *     can only refer to bytes it has itself produced in this message, which sit
 *     at the same relative distance in any receiver's window, retained history
 *     or not. So a fresh-context message decodes on every receiver, whichever
 *     way that receiver handles its own window. (The window SIZE is the one
 *     thing it must respect, hence the grouping by `server_max_window_bits`.)
 *
 *  2. THE SENDER'S WINDOW. This is the one that bites. If the server kept
 *     context takeover, its per-socket deflater would hold history the receiver
 *     believes is laid out one way; writing a message around that deflater puts
 *     bytes into the RECEIVER's window that the deflater never saw, and the
 *     next ordinary message's back-references would then point at the wrong
 *     bytes. Silent corruption. So the shared path is taken ONLY for a socket
 *     that negotiated `server_no_context_takeover`, where `ws` resets the
 *     deflater after every message (`permessage-deflate.js`, `_compress`): the
 *     next ordinary message is itself fresh-context and depends on nothing.
 *     `WS_PER_MESSAGE_DEFLATE` has set `serverNoContextTakeover: true` since
 *     compression shipped, and `ws` stamps it on every accepted offer
 *     (`acceptAsServer`), so every socket connected today already qualifies.
 *     No negotiated parameter changes, and the per-socket deflater is never
 *     touched. A socket without it falls back (`contextTakeover`).
 *
 * Compressing with exactly the options `ws` would use (this socket's own
 * `zlibDeflateOptions` plus its negotiated window) produces the same bytes the
 * per-socket path would have put on the wire; `ws-shared-deflate.test.ts`
 * asserts that byte for byte against `ws`'s own output.
 *
 * ORDERING AND BACKPRESSURE. The frame goes through the socket's own sender,
 * via the very call `ws` makes for an uncompressed message (`sendFrame`, which
 * is what `dispatch` calls), and ONLY when that sender is idle: state DEFAULT,
 * an empty queue, not inside a fragmented message. Idle means `ws` itself would
 * write synchronously right now, so nothing queued can be overtaken. A busy
 * sender (a per-socket compression in flight) falls back to `socket.send`,
 * which queues behind it in order (`senderBusy`). The bytes land in the
 * socket's writable buffer, so `bufferedAmount`, and with it the droppable
 * frames' backpressure check, sees them exactly as it sees any other write.
 *
 * WHAT THIS TOUCHES INSIDE `ws`. Private fields: `_sender` (`_state`, `_queue`,
 * `_firstFragment`, `sendFrame`) and `_extensions['permessage-deflate']`
 * (`params`, `_isServer`, `_threshold`, `_options`). Read against `ws` 8.23;
 * every read is shape-checked per socket and any surprise is a fallback
 * (`wsInternals`), never a throw. A different `ws` minor turns the whole path
 * off until someone re-reads `sender.js` and `permessage-deflate.js` and adds
 * it to {@link AUDITED_WS_MINORS}; the test fails first.
 */

/** `ws` versions whose internals the comment above was checked against. */
export const AUDITED_WS_MINORS: readonly string[] = ["8.23"];

/**
 * Fewer recipients than this and the shared path is not worth it: the one
 * compression it does runs synchronously on the event loop, where `ws` would
 * have done the same work on the zlib thread pool, so it only pays once it
 * replaces several of those.
 *
 * WHY SYNCHRONOUS AT ALL. It is what makes ordering trivial: the frame is on
 * the socket in the same tick `socket.send` would have queued it, so a send
 * the caller makes right after can never overtake it. The cost is small and
 * measured: compressing a 92 KB roster and inflating it back to check it took
 * about 0.75 ms on the bench machine (`compressMs` / `compressions` on the
 * counters, 15.7 ms over 21 compressions), once per broadcast per window size
 * (normally one). The per-socket path it replaces is not free on the event
 * loop either: dispatching 1,000 compressions and their callbacks measured
 * 324 ms of process processor time against 20 ms for the whole shared
 * fan-out, with the same event-loop p99 (1.7 ms) in both.
 */
export const SHARED_DEFLATE_MIN_RECIPIENTS = 8;

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const EXTENSION = "permessage-deflate";
/** `Sender`'s DEFAULT state in `ws` (`sender.js`). */
const SENDER_IDLE = 0;

export type SharedDeflateFallback =
  | "senderBusy"
  | "contextTakeover"
  | "wsInternals"
  | "compressFailed"
  | "verifyFailed";

export interface SharedDeflateStats {
  /** Broadcasts in which at least one socket got the shared frame. */
  broadcasts: number;
  /** Sockets served the shared compressed frame. */
  sockets: number;
  /** Sockets in those broadcasts without the extension, sent the plain frame. */
  plainSockets: number;
  /** zlib runs the shared path made (one per window size per broadcast). */
  compressions: number;
  /** Per-socket zlib runs avoided: `sockets - compressions`, the CPU proxy. */
  compressionsAvoided: number;
  /** Uncompressed bytes zlib did NOT have to read because of it. */
  bytesNotCompressed: number;
  /** Processor time spent in the shared compressions (and their check). */
  compressMs: number;
  /**
   * Flag on and the frame large enough, but fewer than
   * {@link SHARED_DEFLATE_MIN_RECIPIENTS} recipients: the ordinary path.
   */
  skipped: { fewRecipients: number };
  /** Sockets that wanted the shared frame and got `socket.send` instead. */
  fallbacks: Record<SharedDeflateFallback, number>;
}

function emptyStats(): SharedDeflateStats {
  return {
    broadcasts: 0,
    sockets: 0,
    plainSockets: 0,
    compressions: 0,
    compressionsAvoided: 0,
    bytesNotCompressed: 0,
    compressMs: 0,
    skipped: { fewRecipients: 0 },
    fallbacks: {
      senderBusy: 0,
      contextTakeover: 0,
      wsInternals: 0,
      compressFailed: 0,
      verifyFailed: 0,
    },
  };
}

let stats = emptyStats();
let failuresLogged = 0;

/** For `GET /api/admin/metrics` (`runtime.wsSharedDeflate`). A copy. */
export function sharedDeflateStats(): SharedDeflateStats {
  return {
    ...stats,
    compressMs: Math.round(stats.compressMs * 10) / 10,
    skipped: { ...stats.skipped },
    fallbacks: { ...stats.fallbacks },
  };
}

/** Test seam. */
export function resetSharedDeflateStats(): void {
  stats = emptyStats();
}

export function noteSharedDeflateSkipped(reason: "fewRecipients"): void {
  stats.skipped[reason] += 1;
}

// ------------------------------------------------------------ ws internals

interface SenderInternals {
  _state: unknown;
  _queue: unknown;
  _firstFragment: unknown;
  sendFrame: (list: Buffer[], cb?: (error?: Error) => void) => void;
}

interface DeflateInternals {
  params: Record<string, unknown> | null;
  _isServer: unknown;
  _threshold: unknown;
  _options: { zlibDeflateOptions?: zlib.ZlibOptions } | null;
}

interface SocketInternals {
  _sender?: SenderInternals | null;
  _extensions?: Record<string, DeflateInternals | undefined>;
}

function installedWsVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return (require("ws/package.json") as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** The installed `ws`, read once. Exported for the guard test. */
export const INSTALLED_WS_VERSION = installedWsVersion();

const wsAudited =
  INSTALLED_WS_VERSION !== null &&
  AUDITED_WS_MINORS.includes(INSTALLED_WS_VERSION.split(".").slice(0, 2).join("."));

/** Test seam: pretend the installed `ws` was not audited. */
let forceUnaudited = false;
export function setSharedDeflateUnauditedForTests(on: boolean): void {
  forceUnaudited = on;
}

// ------------------------------------------------------------- the frame

/** RFC 6455 header for one unmasked, final, RSV1, text frame of `length`. */
export function compressedTextFrameHeader(length: number): Buffer {
  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }
  header[0] = 0x80 | 0x40 | 0x01; // FIN, RSV1 (compressed), opcode text
  return header;
}

interface Prepared {
  header: Buffer;
  body: Buffer;
}

/**
 * Compresses `payload` the way `ws`'s per-socket deflater would after a reset,
 * then inflates it back and compares, so a bad frame is caught here rather
 * than by a client closing its socket. On failure, the reason, and every socket
 * in that group falls back to `ws`'s own compression.
 */
function compressOnce(
  payload: Buffer,
  options: zlib.ZlibOptions | undefined,
  windowBits: number,
): Prepared | "compressFailed" | "verifyFailed" {
  let deflated: Buffer;
  try {
    deflated = zlib.deflateRawSync(payload, {
      ...options,
      windowBits,
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
  } catch {
    return "compressFailed";
  }
  if (deflated.length < 4 || !deflated.subarray(deflated.length - 4).equals(TRAILER)) {
    return "compressFailed";
  }
  try {
    const back = zlib.inflateRawSync(deflated, {
      windowBits,
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
    if (!back.equals(payload)) {
      return "verifyFailed";
    }
  } catch {
    return "verifyFailed";
  }
  const body = deflated.subarray(0, deflated.length - 4);
  return { header: compressedTextFrameHeader(body.length), body };
}

export type SharedSendResult = "shared" | "plain" | SharedDeflateFallback;

/**
 * One broadcast's worth of shared frames. Create it once per payload, offer it
 * every recipient with {@link SharedDeflateBroadcast.trySend}, and send the
 * ordinary way to every socket it declines.
 */
export class SharedDeflateBroadcast {
  private readonly prepared = new Map<
    zlib.ZlibOptions | undefined,
    Map<number, Prepared | SharedDeflateFallback>
  >();
  private sharedSockets = 0;

  constructor(private readonly payload: Buffer) {}

  /**
   * Writes the shared frame to `socket` when that is provably what `ws` would
   * have put on the wire, and answers why not otherwise. Only `"shared"` means
   * the frame was sent; on anything else the caller does `socket.send` itself
   * (for `"plain"`, a socket without the extension, that IS the plain frame).
   * Never throws. The caller has already checked `readyState === OPEN`.
   */
  trySend(socket: WebSocket): SharedSendResult {
    const result = this.decide(socket as unknown as SocketInternals);
    if (result === "plain") {
      stats.plainSockets += 1;
    } else if (result !== "shared") {
      stats.fallbacks[result] += 1;
    }
    return result;
  }

  private decide(socket: SocketInternals): SharedSendResult {
    if (!wsAudited || forceUnaudited) {
      return "wsInternals";
    }
    const extensions = socket._extensions;
    if (!extensions || typeof extensions !== "object") {
      return "wsInternals";
    }
    const deflate = extensions[EXTENSION];
    if (!deflate) {
      return "plain";
    }
    const params = deflate.params;
    if (
      !params ||
      typeof params !== "object" ||
      deflate._isServer !== true ||
      typeof deflate._threshold !== "number" ||
      !deflate._options ||
      typeof deflate._options !== "object"
    ) {
      return "wsInternals";
    }
    if (params.server_no_context_takeover !== true) {
      return "contextTakeover";
    }
    if (this.payload.length < deflate._threshold) {
      // `ws` would send this one uncompressed, so must we. The caller filters
      // on the shipped threshold already; this is a socket built otherwise.
      return "plain";
    }
    const sender = socket._sender;
    if (
      !sender ||
      typeof sender.sendFrame !== "function" ||
      typeof sender._state !== "number" ||
      !Array.isArray(sender._queue) ||
      typeof sender._firstFragment !== "boolean"
    ) {
      return "wsInternals";
    }
    if (
      sender._state !== SENDER_IDLE ||
      sender._queue.length > 0 ||
      !sender._firstFragment
    ) {
      return "senderBusy";
    }
    const windowBits =
      typeof params.server_max_window_bits === "number"
        ? params.server_max_window_bits
        : zlib.constants.Z_DEFAULT_WINDOWBITS;
    const frame = this.frameFor(deflate._options.zlibDeflateOptions, windowBits);
    if (typeof frame === "string") {
      return frame;
    }
    try {
      sender.sendFrame([frame.header, frame.body]);
    } catch {
      // `sendFrame` is a cork, two writes and an uncork; a destroyed socket
      // reports through its `error` event, not a throw. Should it ever throw,
      // nothing was queued, and the ordinary send reports it the usual way.
      return "wsInternals";
    }
    this.sharedSockets += 1;
    stats.sockets += 1;
    if (this.sharedSockets === 1) {
      stats.broadcasts += 1;
    }
    return "shared";
  }

  private frameFor(
    options: zlib.ZlibOptions | undefined,
    windowBits: number,
  ): Prepared | SharedDeflateFallback {
    let byWindow = this.prepared.get(options);
    if (!byWindow) {
      byWindow = new Map();
      this.prepared.set(options, byWindow);
    }
    const held = byWindow.get(windowBits);
    if (held) {
      if (typeof held !== "string") {
        stats.compressionsAvoided += 1;
        stats.bytesNotCompressed += this.payload.length;
      }
      return held;
    }
    const started = performance.now();
    const made = compressOnce(this.payload, options, windowBits);
    stats.compressMs += performance.now() - started;
    if (typeof made !== "string") {
      stats.compressions += 1;
    } else if (failuresLogged < 10) {
      // Never expected. Every socket in this group falls back to `ws`'s own
      // compression, so nothing is lost but the saving; the log says why.
      failuresLogged += 1;
      logEvent("ws.sharedDeflateFailed", {
        reason: made,
        bytes: this.payload.length,
        windowBits,
      });
    }
    byWindow.set(windowBits, made);
    return made;
  }
}

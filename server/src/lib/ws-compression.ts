import type { PerMessageDeflateOptions } from "ws";

/**
 * WEBSOCKET COMPRESSION POLICY (`permessage-deflate`, RFC 7692).
 *
 * Our frames are repetitive JSON: a `voice-roster` repeats the same twelve
 * field names once per participant, and it is written to every socket that can
 * *see* the channel, not only the people in the call. A 250-person roster is
 * about 85 KB and deflates to about 15 KB, so this is the cheapest large win
 * available on a machine that was measured running out of bandwidth at roughly
 * a quarter of its processor.
 *
 * `ws` disables the extension on the server by default and warns that it costs
 * memory, and that Node's zlib can fragment badly under concurrency on Linux.
 * The settings below are chosen against that warning rather than around it, and
 * every one of them was measured before it was picked.
 *
 * WHAT IS DELIBERATELY ABSENT MATTERS AS MUCH AS WHAT IS SET.
 *
 * There is no `serverMaxWindowBits` and no `clientMaxWindowBits`. Either of
 * them, set to a number, makes `ws` REJECT THE HANDSHAKE WITH 400 for any
 * client that did not offer the matching parameter (`acceptAsServer` throws,
 * and `websocket-server.js` turns that into `Invalid or unacceptable
 * Sec-WebSocket-Extensions header`). Measured against the five stacks that
 * actually connect to this server, only Chromium offers `client_max_window_bits`:
 *
 *   Chromium          permessage-deflate; client_max_window_bits
 *   Firefox           permessage-deflate
 *   WebKit / Safari   permessage-deflate
 *   iOS  (CFNetwork)  permessage-deflate
 *   Android (OkHttp)  permessage-deflate
 *
 * So a window-bits number would have turned four of the five into a connection
 * failure. A smaller window is not worth a login screen that never loads.
 *
 * Note also that `zlibDeflateOptions.windowBits` is a trap: `ws` overwrites it
 * with the negotiated value, so setting it there does nothing at all. The
 * window is always 32 KB, and `memLevel` is the only per-socket memory lever
 * that actually applies.
 */

/**
 * Measured on the frames this server really sends (250-person roster, 84.4 KB):
 *
 *   level 1  15.3 KB   level 3  14.9 KB   level 6  13.8 KB   level 9  13.5 KB
 *   0.20 ms            0.19 ms            0.48 ms            0.71 ms
 *
 * Level 3 is 92% of level 9's compression for 27% of its processor time. Above
 * it the curve is flat and the cost is not, which is the wrong trade for a
 * process whose scarce resource is the event loop during a join storm.
 *
 * `memLevel` 6 rather than the zlib default of 8: the ratio difference is 5.65x
 * against 5.67x (0.4%), and the per-socket zlib context drops from 256 KB to
 * 160 KB. At a thousand sockets that is 94 MB of heap that buys nothing.
 *
 * `chunkSize` is left at the Node default of 16 KB on purpose, and the 1 KB in
 * the `ws` README is not copied. Our compressed frames land at about 15 KB, so
 * 16 KB is exactly one output buffer and one `data` event per frame; 1 KB would
 * turn every roster into fifteen buffers and a concat, for no memory saving
 * worth having.
 */
const ZLIB_DEFLATE_OPTIONS = {
  level: 3,
  memLevel: 6,
} as const;

/**
 * The full option set. Exported so a test can assert the shape rather than
 * trusting a comment.
 */
export const WS_PER_MESSAGE_DEFLATE: PerMessageDeflateOptions = {
  zlibDeflateOptions: ZLIB_DEFLATE_OPTIONS,

  /**
   * NO CONTEXT TAKEOVER, IN BOTH DIRECTIONS. This is the memory decision, and
   * it is also the only reason `threshold` below does anything.
   *
   * With context takeover on (the default), every socket that receives a single
   * data frame allocates a zlib deflate context and HOLDS IT for the life of
   * the socket. With it off, `ws` calls `reset()` after each message, so the
   * retained window cannot accumulate, and — because the deflate stream is
   * created lazily on the first frame that is actually compressed — a socket
   * that only ever sees small frames allocates no zlib context at all. That is
   * most sockets most of the time.
   *
   * It also directly answers the fragmentation warning in the `ws` README: a
   * window that is reset every message is not a long-lived allocation that a
   * thousand concurrent sockets can fragment the heap with.
   *
   * The cost, measured on a realistic mixed stream for one socket (159 frames,
   * 488 KB: roster keyframes, deltas, pongs and typing): 5.72x with context
   * takeover against 4.32x without. The gap is almost entirely small frames
   * that we now skip entirely; the large frames that dominate the bytes keep
   * their full ratio, because a roster is overwhelmingly redundant WITHIN
   * itself, not against the previous one. Since #314 the repeated whole roster
   * — the one case cross-frame history would have helped most — is a delta.
   */
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,

  /**
   * Below this, send the frame uncompressed and do not call zlib at all.
   *
   * `ws` only honours this when no-context-takeover is negotiated, which is why
   * the two settings above are load-bearing for it. On a busy socket 96% of
   * frames are under 512 B and they are a small share of the bytes; a 15-byte
   * `pong` deflates to 17 bytes, so compressing it loses on both size and time.
   * 1024 is the `ws` default and measured no worse than 512 here.
   */
  threshold: 1024,

  /**
   * How many zlib jobs may be in flight at once, process-wide.
   *
   * RAISED FROM THE `ws` DEFAULT OF 10, and this is the one setting here that
   * is not conservative, so it deserves the measurement in full. Our fan-out
   * writes ONE payload to every socket that can see a channel, so a join storm
   * asks for hundreds of compressions in a single tick. At a limit of 10 those
   * queue in batches of ten, each batch costing an event-loop round trip, and
   * time-to-join — the number the whole exercise is about — gets worse.
   *
   * 800 sockets, 300 joining at once, same build, same machine, only this
   * number changed:
   *
   *   limit   join p50   join p95   steady CPU   peak RSS
   *      10     363 ms     412 ms       69.6 %     585 MB
   *      16     181 ms     297 ms       64.6 %     609 MB
   *      32     132 ms     252 ms       60.4 %     609 MB
   *      64     121 ms     283 ms       60.7 %     611 MB
   *
   * 32 is where both curves flatten. Note that memory is FLAT across the whole
   * range: the per-socket deflate contexts are what cost memory, and they exist
   * regardless of this number, because a queued job holds a closure and not a
   * buffer. So raising this does not buy latency with the memory the `ws`
   * README warns about — that warning is about how many zlib streams exist at
   * once, which `threshold` and no-context-takeover above are what actually
   * bound.
   *
   * IT ALSO FEEDS BACKPRESSURE, which is the non-obvious part. `ws` computes
   * `bufferedAmount` as the socket's write queue PLUS the payload of messages
   * still waiting on this limiter, and `ws/fanout.ts` drops supersedable frames
   * — typing, presence, rosters — once that passes
   * `SEND_BACKPRESSURE_BYTES`. So a limit set too low does not merely add
   * latency: it parks payload in `_sender._bufferedBytes` and pushes sockets
   * over the drop threshold, costing roster frames to a queue rather than to a
   * slow client. Every compressed run above still converged 400/400 sockets on
   * the exact roster, which is the check that would have caught it.
   *
   * Worth knowing when reading `ws`: this limiter is module-global and built
   * once from whichever `PerMessageDeflate` is constructed first, so it is a
   * property of the process, not of a socket.
   */
  concurrencyLimit: 32,
};

/**
 * The rollback switch, in the spirit of `TURN_PREFER_STATIC` (CLAUDE.md pitfall
 * 9): compression's known failure mode is memory under concurrency, and that is
 * exactly the kind of thing an operator wants to turn off with one `fly secrets
 * set` at three in the morning rather than a revert and a deploy.
 *
 * `WS_COMPRESSION=off` (or `false`) disables it. Anything else, including
 * unset, leaves it on. Compression is on by default because a self-hoster
 * should get the bandwidth win without reading this file.
 */
export function wsCompressionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.WS_COMPRESSION?.trim().toLowerCase();
  return raw !== "off" && raw !== "false" && raw !== "0";
}

/**
 * What to hand `new WebSocketServer({ perMessageDeflate })`.
 *
 * `false` is `ws`'s own "never negotiate" value, so the switch off is the exact
 * behaviour this server had before compression existed.
 */
export function wsPerMessageDeflate(
  env: NodeJS.ProcessEnv = process.env,
): PerMessageDeflateOptions | false {
  return wsCompressionEnabled(env) ? WS_PER_MESSAGE_DEFLATE : false;
}

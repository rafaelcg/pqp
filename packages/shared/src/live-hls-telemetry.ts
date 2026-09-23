import { z } from "zod";

/**
 * Client playback telemetry for a live watch party (BROADCAST_PIPELINE B0.5).
 *
 * Sampled, batched and droppable BY DESIGN. Sending one row per viewer per
 * segment would put the audience's size directly on the API's write path,
 * which is the exact mistake `hls-playlist-proxy.ts`'s render cache exists to
 * avoid on the READ side. So: one in ten viewers (`isSampledForHlsTelemetry`,
 * deterministic on user id so a reload does not re-roll the die), flushed at
 * most once per `LIVE_HLS_TELEMETRY_FLUSH_MS`, and a batch the server refuses
 * (a schema mismatch, a rate limit, a 503 under load) is a no-op the client
 * never retries -- this is a measurement, not an event nothing else records.
 */

/** How often a sampled viewer's client flushes its buffered samples. */
export const LIVE_HLS_TELEMETRY_FLUSH_MS = 30_000;

/** One in this many viewers is sampled at all. */
export const LIVE_HLS_TELEMETRY_SAMPLE_RATE = 0.1;

/**
 * How long after the first frame a sample still counts as startup
 * (`liveHlsTelemetrySampleSchema.startup`).
 */
export const LIVE_HLS_TELEMETRY_STARTUP_MS = 10_000;

/** A batch larger than this is a bug, not a viewer: refused outright. */
export const LIVE_HLS_TELEMETRY_MAX_BATCH = 40;

/**
 * One viewer's reading of one rung over one reporting window. Every field but
 * `rung` and `latencyMs` is optional: a viewer who cannot compute a given
 * number (no `requestVideoFrameCallback`, say) still reports what it has
 * rather than the whole sample being dropped.
 */
export const liveHlsTelemetrySampleSchema = z.object({
  /** Which rendition this reading is about, e.g. `720p30`. */
  rung: z.string().min(1).max(16),
  /**
   * Encode-to-paint, milliseconds: the PDT of the frag being displayed
   * against wall clock (BROADCAST_PIPELINE B0.3). NEVER capture-to-encode --
   * that estimate is reported separately and must not be added in, so a
   * server aggregating this column never silently mixes a measurement with a
   * guess.
   */
  latencyMs: z.number().finite().nonnegative().max(300_000),
  /** Player's own buffered-ahead distance, seconds. */
  bufferSeconds: z.number().finite().nonnegative().max(3_600).optional(),
  /**
   * Stall EPISODES this window: a `waiting` on the element that was not
   * already inside one. (Before 2026-09-23 the web client also counted the
   * element's `stalled` event, which is a network notice, not a frozen
   * picture.)
   */
  stalls: z.number().int().nonnegative().max(10_000).optional(),
  /**
   * Total time spent frozen this window, milliseconds, including the part of
   * an episode still running when the sample was taken (the rest lands in
   * the next sample). Web clients started sending it on 2026-09-23.
   */
  rebufferMs: z.number().finite().nonnegative().max(3_600_000).optional(),
  /** Time to first frame for this viewing session, milliseconds. */
  startupMs: z.number().finite().nonnegative().max(300_000).optional(),
  /**
   * How many times `hls-watch-player.tsx` has torn down and rebuilt the
   * player instance for this viewing session (B1.3 is the fix; this is the
   * number that proves whether it worked).
   */
  playerRebuildCount: z.number().int().nonnegative().max(1_000).optional(),
  /**
   * Player rebuilds (a torn-down and recreated hls.js instance) that happened
   * inside THIS sample's window, as opposed to `playerRebuildCount`, which is
   * a lifetime counter and so says "rebuilt at some point" in every window
   * after the first rebuild (the 2026-09-21 party read that lifetime number
   * as a per-window rate). Absent from clients that predate it.
   */
  rebuilds: z.number().int().nonnegative().max(1_000).optional(),
  /**
   * True while this viewer is still starting: before the first frame and for
   * `LIVE_HLS_TELEMETRY_STARTUP_MS` after it. The first window after an
   * attach always holds the attach's own buffering, so a stall rate that
   * counts it measures joins, not playback. Absent (old clients) means
   * "unknown", not "steady".
   */
  startup: z.boolean().optional(),
  /**
   * How this viewer is playing right now: `ll` (LL parts), `ll-segments`
   * (whole segments from the LL playlist, the web default since 2026-09-23),
   * `conventional` (the egress ladder), or `pinned` (an LL session the
   * player gave up on and plays with conventional settings). Absent on old
   * clients.
   */
  playerMode: z.enum(["ll", "ll-segments", "conventional", "pinned"]).optional(),
  /**
   * Milliseconds this sample covers. With `rebufferMs` it is what turns a
   * batch into the headline number, frozen seconds per viewer-minute.
   */
  windowMs: z.number().int().nonnegative().max(600_000).optional(),
  /**
   * hls.js seek-over-hole skips this window (`bufferSeekOverHole`): a
   * `waiting` the gap controller resolved by jumping forward, which loses
   * content rather than time. Told apart from `stalls` so a hole problem and
   * a starvation problem do not read as one number.
   */
  holeSkips: z.number().int().nonnegative().max(10_000).optional(),
  /** The tab was hidden at some point in this window (`visibilityState`). */
  hidden: z.boolean().optional(),
  /** The element was muted when the sample was taken. */
  muted: z.boolean().optional(),
  /**
   * hls.js FATAL error details seen this window (`fragLoadTimeOut`, ...),
   * at most four. The server keeps only plain identifiers.
   */
  fatal: z.array(z.string().min(1).max(48)).max(4).optional(),
  /** The latency the player is aiming for right now, milliseconds (LL only). */
  targetLatencyMs: z.number().finite().nonnegative().max(300_000).optional(),
});

export type LiveHlsTelemetrySample = z.infer<typeof liveHlsTelemetrySampleSchema>;

/**
 * One flush: a batch of samples for one viewing session. `sessionId` is the
 * `hls_sessions.id` the playlist's own `#EXT-X-PQP-SESSION` tag carries
 * (BROADCAST_PIPELINE B0.4), so a batch and this server's own `voice.hls*`
 * logs about the same party can be read side by side.
 */
export const liveHlsTelemetryBatchSchema = z.object({
  sessionId: z.string().min(1).max(64),
  /**
   * The `?t=` HLS viewer token the playlist request this batch is about
   * carried, when the client was attached to the signed playlist proxy
   * (`hls-playlist-proxy.ts`) at the time -- absent only for the
   * `LIVE_HLS_SIGNED_URLS=false` configuration, which mints no such token
   * (`stampViewerStream`). The server verifies this and, when it checks out,
   * uses the channel/session it names INSTEAD of trusting `sessionId`, which
   * is otherwise a free-text label the caller could set to anything (a Farol
   * finding, 2026-09-13: "authenticated users can submit telemetry for
   * arbitrary sessions"). `sessionId` is kept regardless, both as the fallback
   * for that unsigned configuration and because it is still what the log line
   * shows a human first.
   */
  sessionToken: z.string().min(1).max(512).optional(),
  samples: z
    .array(liveHlsTelemetrySampleSchema)
    .min(1)
    .max(LIVE_HLS_TELEMETRY_MAX_BATCH),
});

export type LiveHlsTelemetryBatch = z.infer<typeof liveHlsTelemetryBatchSchema>;

/**
 * A stable 32-bit hash, so sampling is deterministic per user without either
 * side needing `crypto` (this runs in the browser and in a plain Node test).
 * Not cryptographic: nobody is defending against a user picking their own id.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Whether this viewer is one of the sampled ones, deterministic on user id
 * (BROADCAST_PIPELINE B0.5): the same person reloading, or watching on two
 * tabs, always lands on the same side of the line, so "one in ten viewers"
 * means ten distinct people, not one person's tab re-rolling the die on every
 * refresh until it gets lucky.
 */
export function isSampledForHlsTelemetry(
  userId: string,
  rate: number = LIVE_HLS_TELEMETRY_SAMPLE_RATE,
): boolean {
  if (rate <= 0) {
    return false;
  }
  if (rate >= 1) {
    return true;
  }
  const fraction = fnv1a(`hls-telemetry:${userId}`) / 0xffffffff;
  return fraction < rate;
}

/**
 * How often a playing watch-party viewer tells the server it is still
 * watching (`POST /api/live-hls/presence`). Unlike telemetry this is EVERY
 * viewer, not a sample: it is what the party's viewer counts are built from
 * (`server/src/voice/hls-viewer-counts.ts`). It carries no measurement, only
 * the `?t=` viewer token the player already holds, and the server turns it
 * into a map write, never a database write.
 */
export const LIVE_HLS_PRESENCE_INTERVAL_MS = 30_000;

export const liveHlsPresenceSchema = z.object({
  /** The `?t=` viewer token from the playlist URL the player is attached to. */
  sessionToken: z.string().min(1).max(512),
});

export type LiveHlsPresence = z.infer<typeof liveHlsPresenceSchema>;

/**
 * Stall watchdog for the HLS watch player. Pure: events and a clock in,
 * decisions out, so the whole policy is unit-testable without a `<video>`.
 *
 * What it watches, from the 2026-09-07 local-stack QA where stopping the
 * egress froze every viewer on the last frame with no copy and no recovery:
 *
 * - hls.js `ERROR`: fatal ones mean hls.js has given up on the source.
 * - the `<video>` element's own `error` event, for the native engine and for
 *   an MSE decode failure that bubbles past hls.js (`onNativeMediaError`).
 * - `waiting` that lasts longer than `stallMs` (8 s) with no `playing`.
 * - the live playlist not advancing: `EXT-X-MEDIA-SEQUENCE` unchanged for
 *   `sequenceStuckMs` (20 s), which is what a dead egress looks like while
 *   the playlist itself still answers. Segments are 4 s
 *   (`LIVE_HLS_SEGMENT_SECONDS`) since 2026-09-12, so the media sequence
 *   legitimately advances only once every 4 s; 20 s is comfortably above
 *   two segments (8 s) of ordinary jitter, not a hair-trigger on it.
 *
 * THE LADDER (`BROADCAST_PIPELINE.md` B1.3). The old policy tried one soft
 * recovery and then tore hls.js down for everything else, including a dead
 * egress a client rebuild can never fix. `tick()` now walks a per-reason
 * ladder of in-place actions, escalating one step per tick while the
 * condition persists, and only reaches `"rebuild"` once that ladder is
 * genuinely exhausted:
 *
 * - `"fatal"` (an hls.js fatal error, or a native media error): try
 *   `recoverMediaError()`, then `startLoad(-1)`, then reload the level
 *   playlist. A `MEDIA_ERR_DECODE` that `recoverMediaError()` did not clear
 *   skips straight past the rest of the ladder to `"rebuild"` — nothing else
 *   here plausibly fixes a broken decoder pipeline.
 * - `"stall"` (buffering, no fatal error): `startLoad(-1)`, then reload the
 *   level playlist. No `recoverMediaError()` — there is no media error to
 *   recover from.
 * - `"sequence-stuck"` (the egress, not this player, is stuck): `startLoad`,
 *   then the harder `stopLoad()` + `startLoad(-1)` reset, then reload the
 *   level playlist — all against the SAME source. Claim 9's server-side
 *   watchdog is already restarting the egress, and a client rebuild cannot
 *   invent segments the server never wrote, so this reason never reaches
 *   `"rebuild"` on its own. Once its ladder is spent it instead asks to
 *   `"reconnect"`: check whether the session has actually moved on, and
 *   adopt it if so. That check repeats for as long as the stall does and
 *   never counts toward `"dead"` — only a person's own "try again" can end a
 *   sequence-stuck stream that outlasts the server's own restart.
 *
 * `"fatal"`/`"stall"` repeat their ladder for up to three full cycles before
 * declaring `"rebuild"` ("no recovery after three attempts"); every
 * `"rebuild"` is counted, and after `maxRebuilds` of them inside `windowMs`
 * the stream is declared dead instead, so a person gets a retry button
 * rather than an endless rebuild loop.
 */
export interface HlsStallOptions {
  stallMs?: number;
  sequenceStuckMs?: number;
  maxRebuilds?: number;
  windowMs?: number;
}

export type HlsStallDecision =
  | "none"
  | "recover-media-error"
  | "start-load"
  | "restart-load"
  | "reload-level"
  | "reconnect"
  | "rebuild"
  | "dead";

/** Why the watchdog last asked for something, for the console and the holding screen. */
export type HlsStallReason = "fatal" | "stall" | "sequence-stuck" | null;

const FATAL_LADDER: readonly HlsStallDecision[] = [
  "recover-media-error",
  "start-load",
  "reload-level",
];
const STALL_LADDER: readonly HlsStallDecision[] = ["start-load", "reload-level"];
const SEQUENCE_STUCK_LADDER: readonly HlsStallDecision[] = [
  "start-load",
  "restart-load",
  "reload-level",
];

/** "no recovery after 3 attempts": three full passes of the ladder above. */
const MAX_LADDER_CYCLES = 3;

export class HlsStallWatch {
  private readonly stallMs: number;
  private readonly sequenceStuckMs: number;
  private readonly maxRebuilds: number;
  private readonly windowMs: number;

  private waitingSince: number | null = null;
  private lastSequence: number | null = null;
  private sequenceSeenAt: number | null = null;
  /** Timestamps of past `"rebuild"` decisions, for the `"dead"` gate. */
  private rebuilds: number[] = [];

  private pendingFatal = false;
  private pendingDecodeError = false;
  /** 1-based cursor into the current episode's ladder; 0 between episodes. */
  private ladderStep = 0;

  constructor(options: HlsStallOptions = {}) {
    this.stallMs = options.stallMs ?? 8_000;
    this.sequenceStuckMs = options.sequenceStuckMs ?? 20_000;
    this.maxRebuilds = options.maxRebuilds ?? 3;
    this.windowMs = options.windowMs ?? 5 * 60_000;
  }

  /** The element started or resumed rendering: the current episode is over. */
  onPlaying(): void {
    this.waitingSince = null;
    this.pendingFatal = false;
    this.pendingDecodeError = false;
    this.ladderStep = 0;
  }

  onWaiting(now: number): void {
    if (this.waitingSince === null) {
      this.waitingSince = now;
    }
  }

  /** hls.js `LEVEL_UPDATED` / `LEVEL_LOADED`: the playlist's media sequence. */
  onMediaSequence(sequence: number, now: number): void {
    if (sequence !== this.lastSequence) {
      this.lastSequence = sequence;
      this.sequenceSeenAt = now;
    }
  }

  /** hls.js `ERROR`. A fatal one joins the ladder on the next tick. */
  onError(input: { fatal: boolean }): void {
    if (input.fatal) {
      this.pendingFatal = true;
    }
  }

  /**
   * The `<video>` element's own `error` event: the native engine, or an MSE
   * decode failure that bubbled past hls.js. `decode` is
   * `video.error?.code === MediaError.MEDIA_ERR_DECODE` — the one case the
   * ladder short-circuits, because `recoverMediaError()` is the one remedy
   * built for it and there is nothing to gain from trying the rest.
   */
  onNativeMediaError(input: { decode: boolean }): void {
    this.pendingFatal = true;
    if (input.decode) {
      this.pendingDecodeError = true;
    }
  }

  /** A new source was attached: forget the old playlist's timeline. */
  onSourceChanged(now: number): void {
    this.waitingSince = null;
    this.lastSequence = null;
    this.sequenceSeenAt = now;
    this.pendingFatal = false;
    this.pendingDecodeError = false;
    this.ladderStep = 0;
    // `rebuilds` deliberately survives a mere re-attach: repeated instance
    // churn inside the dead-window is exactly what should end in `"dead"`
    // rather than another rebuild, and a rebuild is the only thing that
    // calls this.
  }

  /** The person pressed "try again": a clean slate, including the dead-window. */
  reset(now: number): void {
    this.rebuilds = [];
    this.onSourceChanged(now);
  }

  /** Why the last non-`"none"` `tick` fired, for the console and the UI. */
  lastReason: HlsStallReason = null;

  private currentReason(now: number): HlsStallReason {
    if (this.pendingFatal || this.pendingDecodeError) {
      return "fatal";
    }
    if (
      this.waitingSince !== null &&
      now - this.waitingSince >= this.stallMs
    ) {
      return "stall";
    }
    if (
      this.sequenceSeenAt !== null &&
      this.lastSequence !== null &&
      now - this.sequenceSeenAt >= this.sequenceStuckMs
    ) {
      return "sequence-stuck";
    }
    return null;
  }

  tick(now: number): HlsStallDecision {
    const reason = this.currentReason(now);
    if (reason === null) {
      this.ladderStep = 0;
      return "none";
    }
    if (reason !== this.lastReason) {
      // Either a fresh episode, or a more specific reason just pre-empted a
      // milder one (a fatal error arriving mid-"stall"): either way the
      // ladder that applies changed, so start it over.
      this.ladderStep = 0;
    }
    this.lastReason = reason;
    this.ladderStep += 1;

    if (this.pendingDecodeError && this.ladderStep > 1) {
      // Step 1 (`recoverMediaError()`) already ran and the decode error is
      // still here: nothing else in the ladder fixes a broken decoder.
      return this.gateRebuild(now);
    }

    if (reason === "sequence-stuck") {
      const index = this.ladderStep - 1;
      if (index < SEQUENCE_STUCK_LADDER.length) {
        return SEQUENCE_STUCK_LADDER[index]!;
      }
      // The in-place ladder is spent and the egress is still not producing.
      // Ask whether the session moved on rather than rebuilding blind onto
      // the same dead source; repeat for as long as this lasts. Never
      // reaches `"dead"` on its own — that gate is the fatal/stall path's.
      this.ladderStep = SEQUENCE_STUCK_LADDER.length;
      return "reconnect";
    }

    const ladder = reason === "fatal" ? FATAL_LADDER : STALL_LADDER;
    const position = (this.ladderStep - 1) % ladder.length;
    const cycle = Math.floor((this.ladderStep - 1) / ladder.length);
    if (cycle >= MAX_LADDER_CYCLES) {
      return this.gateRebuild(now);
    }
    return ladder[position]!;
  }

  private gateRebuild(now: number): HlsStallDecision {
    this.rebuilds = this.rebuilds.filter((at) => now - at < this.windowMs);
    if (this.rebuilds.length >= this.maxRebuilds) {
      return "dead";
    }
    this.rebuilds.push(now);
    // If the caller actually rebuilds, `onSourceChanged` resets this for the
    // new instance. If it does not (nothing left to gain, see B1.3), the
    // condition is still active on the next tick and a fresh ladder walk
    // starts here again, reaching this gate roughly once per cycle.
    this.ladderStep = 0;
    return "rebuild";
  }
}

/**
 * The channel a playlist URL belongs to, so the player can ask
 * `GET /api/channels/:id/live` for a fresh source on its own. Both shapes
 * the server hands out carry it: the signed proxy path
 * (`/api/voice/hls-playlist/<channel>/<startedAt>`) and the raw bucket URL
 * (`.../live/<channel>/<startedAt>.m3u8`).
 */
export function channelIdFromHlsUrl(url: string): string | null {
  const proxy = /\/api\/voice\/hls-playlist\/([^/?#]+)\//.exec(url);
  if (proxy) {
    return proxy[1]!;
  }
  const raw = /\/live\/([^/?#]+)\/[^/?#]+\.m3u8/.exec(url);
  return raw ? raw[1]! : null;
}

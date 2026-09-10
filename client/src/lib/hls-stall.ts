/**
 * Stall watchdog for the HLS watch player. Pure: events and a clock in,
 * decisions out, so the whole policy is unit-testable without a `<video>`.
 *
 * What it watches, from the 2026-09-07 local-stack QA where stopping the
 * egress froze every viewer on the last frame with no copy and no recovery:
 *
 * - hls.js `ERROR`: fatal ones (network or media) mean the source is gone.
 *   Non-fatal ones are counted but only matter once they pile up.
 * - `waiting` that lasts longer than `stallMs` (8 s) with no `playing`.
 * - the live playlist not advancing: `EXT-X-MEDIA-SEQUENCE` unchanged for
 *   `sequenceStuckMs` (15 s), which is what a dead egress looks like while
 *   the playlist itself still answers.
 *
 * Every reconnect refetches the playlist source (a restarted egress has a
 * new URL); after `maxReconnects` inside `windowMs` the stream is declared
 * dead and the person gets a retry button instead of a spinner.
 */
export interface HlsStallOptions {
  stallMs?: number;
  sequenceStuckMs?: number;
  maxReconnects?: number;
  windowMs?: number;
}

export type HlsStallDecision = "none" | "recover" | "reconnect" | "dead";

export class HlsStallWatch {
  private readonly stallMs: number;
  private readonly sequenceStuckMs: number;
  private readonly maxReconnects: number;
  private readonly windowMs: number;
  private waitingSince: number | null = null;
  private lastSequence: number | null = null;
  private sequenceSeenAt: number | null = null;
  private reconnects: number[] = [];
  private pendingFatal = false;
  private triedRecover = false;

  constructor(options: HlsStallOptions = {}) {
    this.stallMs = options.stallMs ?? 8_000;
    this.sequenceStuckMs = options.sequenceStuckMs ?? 15_000;
    this.maxReconnects = options.maxReconnects ?? 3;
    this.windowMs = options.windowMs ?? 5 * 60_000;
  }

  /** The element started or resumed rendering: every stall clock resets. */
  onPlaying(): void {
    this.waitingSince = null;
    this.triedRecover = false;
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

  /** hls.js `ERROR`. A fatal one asks for a reconnect on the next tick. */
  onError(input: { fatal: boolean }): void {
    if (input.fatal) {
      this.pendingFatal = true;
    }
  }

  /** A new source was attached: forget the old playlist's timeline. */
  onSourceChanged(now: number): void {
    this.waitingSince = null;
    this.lastSequence = null;
    this.sequenceSeenAt = now;
    this.pendingFatal = false;
    this.triedRecover = false;
  }

  /** The person pressed "try again": a clean slate. */
  reset(now: number): void {
    this.reconnects = [];
    this.onSourceChanged(now);
  }

  /** Why the last `tick` asked for a reconnect, for the console. */
  lastReason: "fatal" | "stall" | "sequence-stuck" | null = null;

  tick(now: number): HlsStallDecision {
    let reason: typeof this.lastReason = null;
    if (this.pendingFatal) {
      reason = "fatal";
    } else if (
      this.waitingSince !== null &&
      now - this.waitingSince >= this.stallMs
    ) {
      reason = "stall";
    } else if (
      this.sequenceSeenAt !== null &&
      this.lastSequence !== null &&
      now - this.sequenceSeenAt >= this.sequenceStuckMs
    ) {
      reason = "sequence-stuck";
    }
    if (reason === null) {
      return "none";
    }
    this.lastReason = reason;
    // A stuck media sequence is a dead egress: the playlist still answers
    // and in-place recovery cannot invent new segments. Stall and fatal
    // media errors often recover without tearing hls.js down, and a
    // teardown reseeds ABR at the bottom rung — so try that once first.
    if (reason !== "sequence-stuck" && !this.triedRecover) {
      this.triedRecover = true;
      this.pendingFatal = false;
      return "recover";
    }
    this.reconnects = this.reconnects.filter((at) => now - at < this.windowMs);
    if (this.reconnects.length >= this.maxReconnects) {
      return "dead";
    }
    this.reconnects.push(now);
    // The new attempt starts its own clocks; a reconnect that itself stalls
    // is judged from its attach, not from the original stall.
    this.onSourceChanged(now);
    return "reconnect";
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

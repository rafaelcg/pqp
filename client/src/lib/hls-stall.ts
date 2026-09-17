import {
  classifyLlHlsError,
  describeHlsError,
  llPartStuckMs,
  llSequenceStuckMs,
  LL_HLS_MAX_MEDIA_REBUILDS,
  LL_HLS_STARTUP_GRACE_MS,
  validPartTargetMs,
  validTargetDurationSeconds,
  type HlsErrorSummary,
  type HlsMode,
} from "./hls-live-edge";

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
 * - the live playlist not advancing: its NEWEST segment number (hls.js
 *   `endSN`, see `livePlaylistProgress`) unchanged for `sequenceStuckMs`
 *   (20 s), which is what a dead egress looks like while the playlist
 *   itself still answers. Segments are 4 s (`LIVE_HLS_SEGMENT_SECONDS`)
 *   since 2026-09-12, so the newest segment legitimately advances only once
 *   every 4 s; 20 s is comfortably above two segments (8 s) of ordinary
 *   jitter, not a hair-trigger on it. NOT `EXT-X-MEDIA-SEQUENCE` (`startSN`):
 *   the API's playlist proxy widens the egress's five-segment window from
 *   the segments each PROCESS has seen (`server/src/voice/hls-live-window.ts`),
 *   so the first listed segment, and with it the media sequence, sits still
 *   for the first 15 segments (60 s) of every session, and again after every
 *   API restart. Keying on it froze every viewer with "holding for restart"
 *   at the start of every party (live session 2026-09-16 19:12Z: the bucket
 *   advanced every 4.0 s the whole time).
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
 * - `"sequence-stuck"` / `"playlist-gone"` (the egress, not this player):
 *   Claim 9's server-side watchdog is already restarting the egress, and a
 *   client rebuild cannot invent segments the server never wrote, so these
 *   reasons never reach `"rebuild"` on their own.
 *
 *   CONVENTIONAL (the 2026-09-15 restart dead-window polish): skip the
 *   in-place `startLoad` / `restart-load` / `reload-level` ladder entirely.
 *   Those steps hammer a dying or already-404ing playlist at ~1 Hz and
 *   re-download the last known segment into an ugly 1–2 s loop while the
 *   new master is still 10–15 s away. Instead: one `"hold"` (caller
 *   `stopLoad()`s and shows the restarting UI), then bounded `"reconnect"`
 *   polls for a fresh session. `"playlist-gone"` (own proxy answered
 *   404/410) enters that path immediately, without waiting out
 *   `sequenceStuckMs`.
 *
 *   LL keeps the older three-step in-place ladder, then the same
 *   `"reconnect"` backoff. Do not fold the conventional hold into LL — PR 646
 *   tried a broader live-edge recovery and PR 650 had to revert it after it
 *   broke conventional playback.
 *
 *   `"reconnect"` checks back off (doubling, capped at
 *   `reconnectBackoffMaxMs`) instead of firing on every tick, and after
 *   `maxReconnects` of them with no session change the stream is declared
 *   `"dead"` too -- a stuck egress the server's own watchdog cannot revive
 *   inside that budget is no longer this player's problem to keep polling
 *   for, and a person still has "try again" (`reset()`) for a clean slate.
 *
 *   FIXED (Farol review, PR 570). The first cut asked again on every tick
 *   for as long as the stall lasted, with no ceiling at all: a stuck egress
 *   turned into roughly one `fetchChannelLive` per viewer per second for the
 *   whole outage, worse once the API itself was the slow part and requests
 *   started overlapping.
 *
 * THE STARTUP GRACE (LL only, `LL_HLS_STARTUP_GRACE_MS`). The soft rules --
 * `"stall"` and the part-stuck nudge -- say nothing for the first seconds of
 * an LL attach. A player waiting out the edge's `503 Retry-After: 1` while
 * the remux warms up, and then filling a six-second buffer out of 500 ms
 * parts, is indistinguishable from a stalled one by those two rules, and
 * `LL_HLS_PART_STUCK_PARTS` is only two seconds: the nudge fired a
 * `startLoad` into a load that was going fine, which is the client's half of
 * the "struggles until it settles" the first sustained LL run showed. A
 * fatal error is NOT graced -- a source that is gone at second two is gone.
 * Conventional sessions set the grace to 0 and are byte-identical to before.
 *
 * WHAT LL JUDGES "STUCK" ON, SINCE 2026-09-16. Three rules changed, all of
 * them gated on `mode === "ll"` so the conventional path is byte-identical:
 *
 * 1. PARTS, NOT `EXT-X-MEDIA-SEQUENCE`. The media sequence only moves when a
 *    closed segment leaves the window, and `pqp-remux` closes a video
 *    segment on an IDR: real segments run 5 to 9 s and the live party
 *    advertised `EXT-X-TARGETDURATION 7`. A part arriving is proof the
 *    stream is alive, so `"sequence-stuck"` is now a BACKSTOP that only
 *    speaks when parts have stopped too (`partsAdvancing`), and its
 *    threshold comes from the manifest (`llSequenceStuckMs`, three
 *    TARGETDURATIONs) rather than from a constant that guessed 4 s.
 * 2. THE PART RULE READS THE MANIFEST TOO (`onManifestTiming`): four of the
 *    playlist's own `PART-TARGET`, and only for parts the playlist actually
 *    lists.
 * 3. hls.js's BUFFER EVENTS ARE NOT SOURCE DEATHS (`classifyLlHlsError`).
 *    `GapController._tryNudgeBuffer` raises `bufferStalledError` to
 *    `fatal: true` after its nudge budget; on a starved presenter upload
 *    that is a statement about the buffer, and answering it with the fatal
 *    ladder rebuilt the player and cancelled the very part downloads that
 *    were filling it. It opens an ordinary buffering episode instead. A
 *    media-pipeline error (`bufferAppendError`, `fragParsingError`, ...)
 *    gets one `recoverMediaError()` and a BOUNDED rebuild
 *    (`LL_HLS_MAX_MEDIA_REBUILDS`), then the holding screen.
 *
 * And every ladder line the player logs now carries `describeContext()`:
 * hls.js's own `type`/`details`/`fatal`/`reason`/message plus the cadence
 * the thresholds were derived from. The capture that found all of this said
 * only `[hls] stream stalled (fatal), start-load`, which named our verdict
 * and nothing about its cause.
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
  /** First wait before a `"sequence-stuck"` reconnect check repeats. */
  reconnectBackoffMs?: number;
  /** Ceiling the doubling reconnect backoff above never exceeds. */
  reconnectBackoffMaxMs?: number;
  /** Reconnect checks (post-ladder) before a stuck egress is `"dead"`. */
  maxReconnects?: number;
}

export type HlsStallDecision =
  | "none"
  | "recover-media-error"
  | "start-load"
  | "restart-load"
  | "reload-level"
  /**
   * Conventional egress-restart dead window (2026-09-15): stop loading, show
   * the restarting holding screen, and wait for a reconnect poll to adopt a
   * fresh master. Never startLoad / reload-level — those hammer a 404ing
   * playlist and re-download the last segment into a 1–2 s loop.
   */
  | "hold"
  | "reconnect"
  | "rebuild"
  | "dead"
  /**
   * LL only, and only for a "stall" episode's FIRST rung on an attach that
   * has never painted a frame -- production, 2026-09-17: a viewer who
   * opened a party right as its LL session (re)started requested
   * `_HLS_msn=23` while the real playlist was already at 33-37, hls.js
   * appended nothing usable, `bufferSeekOverHole`/`bufferStalledError`
   * followed, and the watchdog spent ~40 s walking `start-load` /
   * `reload-level` / a full rebuild before the REBUILT instance happened to
   * land on the live edge on its own. hls.js's own `synchronizeToLiveEdge`
   * is supposed to force exactly this seek once `liveSyncPosition` and
   * `config.liveMaxLatencyDuration` disagree with the playhead, but only
   * once `media.readyState` is past `HAVE_NOTHING` -- a player that never
   * got a usable append never reaches that branch and sits stuck instead.
   * `HlsWatchPlayer`'s stall tick answers this decision with the SAME
   * bounded live-edge jump `isMissingFragmentError` already uses
   * (`canJumpToLiveEdge`'s shared budget), and only falls back to the
   * ordinary `"start-load"` rung when that budget or a live edge is not
   * there to jump to. Never fires for conventional or VOD (`configureForMode`
   * gates the whole rule on `mode === "ll"`), and never more than once per
   * attach (`hasPlayed`/`jumpOffered`) -- a stall discovered after real
   * playback started is the starved-presenter case
   * `classifyLlHlsError`'s "buffer" family already protects, untouched here.
   */
  | "jump-live";

/** Why the watchdog last asked for something, for the console and the holding screen. */
export type HlsStallReason =
  | "fatal"
  | "stall"
  | "sequence-stuck"
  /** Own playlist/master answered 404/410 — the session is gone (restart). */
  | "playlist-gone"
  | "part-stuck"
  | null;

/**
 * The `stallMs` the watch player actually constructs `HlsStallWatch` with —
 * raised from the class default (8 s) so the ladder's `reload-level` step
 * (the one that visibly re-buffers and can look like a few seconds of the
 * stream repeating) is not the first thing tried for a `waiting` spell a
 * CPU-saturated-but-alive egress could still recover from on its own. Paired
 * with `HLS_NUDGE_MAX_RETRY` (`hls-live-edge.ts`), which delays hls.js's own
 * `"fatal"` declaration for the same reason — this timer fires independently
 * of that one, so raising only one of the two still lets the other trip the
 * ladder early. See that constant's comment for the full reasoning and the
 * 2026-09-14 watch party this was tuned against.
 */
/**
 * What counts as the live playlist moving, for `onMediaSequence`: the
 * newest segment number. A dead egress stops appending segments, so this
 * stops; a window that is still growing (the proxy's widened window after a
 * session start or an API restart) keeps appending while its FIRST segment,
 * `EXT-X-MEDIA-SEQUENCE` / `startSN`, sits still for a minute. Feeding the
 * watchdog `startSN` called that growth a dead egress; see the class doc.
 */
export function livePlaylistProgress(details: {
  startSN: number;
  endSN: number;
}): number {
  return details.endSN;
}

export const HLS_WATCH_PLAYER_STALL_MS = 15_000;

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
  /** Mutable: LL paces this off the manifest -- see `llSequenceStuckMs`. */
  private sequenceStuckMs: number;
  /** The constructed value, restored by `configureForMode("conventional")`. */
  private readonly defaultSequenceStuckMs: number;
  private readonly maxRebuilds: number;
  private readonly windowMs: number;
  private readonly reconnectBackoffMs: number;
  private readonly reconnectBackoffMaxMs: number;
  private readonly maxReconnects: number;

  private waitingSince: number | null = null;
  private lastSequence: number | null = null;
  private sequenceSeenAt: number | null = null;
  /**
   * Whether `onPlaying` has fired at all since the last `onSourceChanged`
   * (a real attach, LL or not -- reset there and nowhere else, including a
   * ladder-triggered same-URL rebuild, which is a fresh hls.js instance
   * that has genuinely not painted anything yet either). Read only by
   * `"jump-live"`'s gate below: a stall discovered before the FIRST frame
   * is "this attach may have landed behind the live edge", the one the
   * 2026-09-17 incident was; the identical error after a frame has already
   * painted is an ordinary mid-party stall and must not trip this rule.
   */
  private hasPlayed = false;
  /**
   * Whether `"jump-live"` has already been offered once for the CURRENT
   * `hasPlayed === false` stretch. Deliberately separate from `ladderStep`:
   * `gateRebuild` resets `ladderStep` to 0 on every full ladder cycle
   * (three cycles of the "stall" ladder, still with no `onPlaying` in
   * between on a fake/never-recovering source), which put `ladderStep` back
   * at 1 -- and re-offered the jump -- every ~6-7 ticks instead of once per
   * attach (caught by this PR's own component test:
   * `hls-watch-player-ll-recovery.test.tsx` saw repeated `stopLoad` /
   * `startLoad` pairs instead of one). Reset only where `hasPlayed` is.
   */
  private jumpOffered = false;
  /**
   * LL only: `null` disables the part-stuck rule entirely (the constructed
   * default, and every conventional session). Set by `configureForMode`.
   */
  private partStuckMs: number | null = null;
  /** The server-advertised part target, validated, for the LL thresholds. */
  private partTargetMs: number = 0;
  /** `EXT-X-TARGETDURATION` as last seen on the playlist, LL only. */
  private targetDurationSeconds: number | null = null;
  /** `PART-TARGET` as last seen on the playlist, LL only. */
  private manifestPartTargetSeconds: number | null = null;
  /** The last hls.js (or native) error seen, for `describeContext`. */
  private lastError: HlsErrorSummary | null = null;
  /** LL only: the pending fatal is a media-pipeline failure, not a network one. */
  private pendingMediaFatal = false;
  /** Rebuilds spent on media-class errors; cleared by a real recovery. */
  private mediaRebuilds = 0;
  /**
   * How long after an attach the soft rules stay quiet. 0 -- the constructed
   * default and every conventional session -- is no grace at all, i.e.
   * byte-identical to before this existed. Set by `configureForMode`.
   */
  private startupGraceMs = 0;
  /**
   * When this attach started, for the grace above. Set by `onSourceChanged`
   * and, for a watch whose caller never calls it, lazily on the first
   * `tick` -- so the clock is always the caller's, never `Date.now()`.
   */
  private attachedAt: number | null = null;
  /** The newest known (segment, part-index) key `onPartAdvance` has seen. */
  private lastPartKey: string | null = null;
  private partSeenAt: number | null = null;
  /** This stall episode's one-shot part-stuck nudge has already fired. */
  private partStuckFired = false;
  /** Timestamps of past `"rebuild"` decisions, for the `"dead"` gate. */
  private rebuilds: number[] = [];
  /** How many `"reconnect"` checks this episode has already asked for. */
  private reconnectAttempts = 0;
  /** Earliest time the next `"reconnect"` may fire; null means "now". */
  private nextReconnectAt: number | null = null;
  /**
   * `"conventional"` (default) holds through a restart dead window instead
   * of walking the in-place sequence-stuck ladder; `"ll"` keeps that ladder.
   * Set by `configureForMode`.
   */
  private mode: HlsMode = "conventional";
  /**
   * Own playlist/master answered 404/410. Conventional only — the player
   * gates the call; once set, `tick` enters the hold/reconnect path without
   * waiting out `sequenceStuckMs`.
   */
  private playlistGone = false;
  /**
   * This episode already emitted `"hold"`. Further ticks go straight to
   * the reconnect backoff rather than repeating stopLoad every second.
   */
  private heldForRestart = false;

  private pendingFatal = false;
  private pendingDecodeError = false;
  /** 1-based cursor into the current episode's ladder; 0 between episodes. */
  private ladderStep = 0;

  constructor(options: HlsStallOptions = {}) {
    this.stallMs = options.stallMs ?? 8_000;
    this.sequenceStuckMs = options.sequenceStuckMs ?? 20_000;
    this.defaultSequenceStuckMs = this.sequenceStuckMs;
    this.maxRebuilds = options.maxRebuilds ?? 3;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.reconnectBackoffMs = options.reconnectBackoffMs ?? 2_000;
    this.reconnectBackoffMaxMs = options.reconnectBackoffMaxMs ?? 20_000;
    this.maxReconnects = options.maxReconnects ?? 8;
  }

  /**
   * §5, corrected after a Farol review of this PR: the ladder's
   * `sequence-stuck` reason keys on `EXT-X-MEDIA-SEQUENCE`, which only
   * advances once per closed SEGMENT even in LL mode, so scaling that
   * threshold to a handful of PARTS (the first cut of this method) fired the
   * full escalating ladder on a perfectly healthy stream. `sequenceStuckMs`
   * on LL is therefore segment-paced (`llSequenceStuckMs`: three
   * `EXT-X-TARGETDURATION`s once a manifest has been seen) and independent
   * of `partTargetMs` entirely -- and, since 2026-09-16, a BACKSTOP that
   * only speaks when parts have stopped too (`partsAdvancing`). The genuinely part-paced signal is the
   * SEPARATE `partStuckMs` rule below, fed by `onPartAdvance` and read only
   * in `tick()`'s "nothing else is already flagged" branch -- it fires the
   * ladder's first in-place step once, then gets out of the way; the
   * segment rule above is what actually reconnects/rebuilds a stream that
   * stays broken.
   *
   * Called once per attach (`HlsWatchPlayer`), never mid-episode, so this
   * never fights a ladder that is already walking: `conventional` restores
   * exactly the constructor's thresholds and disables the part rule. Mode
   * also selects the sequence-stuck policy (hold+reconnect on conventional,
   * in-place ladder on LL).
   */
  configureForMode(mode: HlsMode, partTargetMs?: number): void {
    this.mode = mode;
    this.targetDurationSeconds = null;
    this.manifestPartTargetSeconds = null;
    if (mode === "ll") {
      this.partTargetMs = validPartTargetMs(partTargetMs);
      // The manifest has not been seen yet: `HLS_LIVE_SEGMENT_SECONDS` is
      // the starting guess and `onManifestTiming` replaces it with what the
      // playlist actually promises, which on a real party is nearly twice
      // as long.
      this.sequenceStuckMs = llSequenceStuckMs(null);
      this.partStuckMs = llPartStuckMs(this.partTargetMs, null);
      this.startupGraceMs = LL_HLS_STARTUP_GRACE_MS;
      return;
    }
    this.sequenceStuckMs = this.defaultSequenceStuckMs;
    this.partStuckMs = null;
    this.startupGraceMs = 0;
  }

  /**
   * LL only: what the playlist says about its OWN cadence, from hls.js's
   * `LEVEL_UPDATED` (`details.targetduration`, `details.partTarget`). Both
   * thresholds are re-derived from it, because a rule about "the stream
   * stopped" has to be paced by the stream, not by a constant that happened
   * to match an earlier deployment (production, 2026-09-16: a flat 12 s
   * against segments that legitimately run up to 9 s).
   *
   * Conventional sessions never call this and are untouched by it.
   */
  onManifestTiming(input: {
    targetDurationSeconds?: number | null;
    partTargetSeconds?: number | null;
  }): void {
    if (this.mode !== "ll") {
      return;
    }
    const target = validTargetDurationSeconds(input.targetDurationSeconds);
    if (target !== null) {
      this.targetDurationSeconds = target;
      this.sequenceStuckMs = llSequenceStuckMs(target);
    }
    const partTarget = input.partTargetSeconds;
    if (
      typeof partTarget === "number" &&
      Number.isFinite(partTarget) &&
      partTarget > 0
    ) {
      this.manifestPartTargetSeconds = partTarget;
    }
    this.partStuckMs = llPartStuckMs(
      this.partTargetMs,
      this.manifestPartTargetSeconds,
    );
  }

  /**
   * Everything the next production capture needs in one string: which
   * hls.js error was last seen (type, details, fatal, reason, message) and
   * the cadence the thresholds were derived from. Empty on conventional, so
   * that path's log lines stay exactly what they were.
   */
  describeContext(): string {
    if (this.mode !== "ll") {
      return "";
    }
    const parts: string[] = [];
    const error = describeHlsError(this.lastError);
    if (error) {
      parts.push(error);
    }
    parts.push(
      `targetDuration=${this.targetDurationSeconds ?? "?"}s`,
      `partTarget=${(this.manifestPartTargetSeconds ?? this.partTargetMs / 1_000).toFixed(3)}s`,
      `seqStuckMs=${this.sequenceStuckMs}`,
      `partStuckMs=${this.partStuckMs ?? "off"}`,
    );
    return parts.join(" ");
  }

  /**
   * LL only: parts are still arriving, so whatever else is wrong the stream
   * itself is not stuck. This is what demotes the `EXT-X-MEDIA-SEQUENCE`
   * rule to a backstop -- see `currentReason`.
   */
  private partsAdvancing(now: number): boolean {
    return (
      this.partStuckMs !== null &&
      this.lastPartKey !== null &&
      this.partSeenAt !== null &&
      now - this.partSeenAt < this.partStuckMs
    );
  }

  /** Still inside this attach's startup grace (LL only; 0 elsewhere). */
  private inStartupGrace(now: number): boolean {
    return (
      this.startupGraceMs > 0 &&
      this.attachedAt !== null &&
      now - this.attachedAt < this.startupGraceMs
    );
  }

  /**
   * LL only: a genuinely new part arrived. `key` names the newest known
   * (segment, part-index) pair -- callers compute it from hls.js's
   * `LevelDetails.lastPartSn`/`lastPartIndex` on `LEVEL_UPDATED`, which
   * fires per part under LL's blocking reload, not only per segment -- and
   * only a CHANGE here counts as progress, the same shape `onMediaSequence`
   * already uses for the segment number. Re-arms `partStuckFired` so a
   * later stall episode (after a real recovery) can trigger the one-shot
   * nudge again.
   */
  onPartAdvance(key: string, now: number): void {
    if (key !== this.lastPartKey) {
      this.lastPartKey = key;
      this.partSeenAt = now;
      this.partStuckFired = false;
    }
  }

  /** The element started or resumed rendering: the current episode is over. */
  onPlaying(): void {
    this.hasPlayed = true;
    this.waitingSince = null;
    // A restart hold (`playlist-gone` or conventional sequence-stuck after
    // `"hold"`): buffered media can still emit `playing` after `stopLoad`.
    // That is not recovery — clearing here would drop reconnect polling and
    // leave the player on a stale frame (Farol, PR 654). Clear only on a
    // real re-attach (`onSourceChanged`) or when the playlist advances
    // again (`onMediaSequence`).
    if (this.playlistGone || this.heldForRestart) {
      return;
    }
    this.pendingFatal = false;
    this.pendingDecodeError = false;
    this.pendingMediaFatal = false;
    // A picture that is moving again is the recovery the media-rebuild
    // budget exists to find: give the next, unrelated episode its own.
    this.mediaRebuilds = 0;
    this.ladderStep = 0;
    this.reconnectAttempts = 0;
    this.nextReconnectAt = null;
  }

  /**
   * True while a conventional restart hold is active. The player's
   * `playing` handler must not clear the restarting UI or cancel a
   * pending reconnect while this is set.
   */
  get isHoldingForRestart(): boolean {
    return this.playlistGone || this.heldForRestart;
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
      // A live playlist that advances again is real recovery from a
      // conventional hold (same session came back). Clear the hold the
      // way `onSourceChanged` does for a new session — `onPlaying` alone
      // must not (Farol, PR 654).
      if (this.playlistGone || this.heldForRestart) {
        this.playlistGone = false;
        this.heldForRestart = false;
        this.pendingFatal = false;
        this.pendingDecodeError = false;
        this.ladderStep = 0;
        this.reconnectAttempts = 0;
        this.nextReconnectAt = null;
      }
    }
  }

  /**
   * hls.js `ERROR`. A fatal one joins the ladder on the next tick --
   * EXCEPT, on LL, for the buffer family.
   *
   * `bufferStalledError` goes `fatal: true` once hls.js has spent
   * `nudgeMaxRetry` nudges on a playhead that will not move
   * (`GapController._tryNudgeBuffer`). That is a statement about the buffer,
   * and on 2026-09-16 it was the whole of what a starved presenter upload
   * produced: the fatal ladder ran `recover-media-error`, `start-load`,
   * `reload-level` and then rebuilt the player, which cancelled the part
   * downloads that were slowly filling the buffer, and the new player
   * arrived at the same place. It opens an ordinary buffering episode now
   * -- the soft ladder, and a person sees buffering rather than a teardown.
   *
   * `details` and `now` are optional so every existing caller and test that
   * passes only `{ fatal }` keeps exactly the behaviour it had.
   */
  onError(input: {
    fatal: boolean;
    type?: string | null;
    details?: string | null;
    reason?: string | null;
    message?: string | null;
    now?: number;
  }): void {
    this.lastError = {
      type: input.type ?? null,
      details: input.details ?? null,
      fatal: input.fatal,
      reason: input.reason ?? null,
      message: input.message ?? null,
    };
    if (this.mode === "ll") {
      const kind = classifyLlHlsError(input.details);
      if (kind === "buffer") {
        // Never the fatal ladder, fatal flag or not. hls.js only says this
        // when playback is genuinely not progressing, so it is honest to
        // open the buffering episode here even if the element's own
        // `waiting` has not fired (or fired and was cleared by a `playing`
        // that did not last).
        if (typeof input.now === "number") {
          this.onWaiting(input.now);
        }
        return;
      }
      if (input.fatal && kind === "media") {
        this.pendingFatal = true;
        this.pendingMediaFatal = true;
        return;
      }
    }
    if (input.fatal) {
      this.pendingFatal = true;
    }
  }

  /**
   * Own playlist/master answered 404/410. The egress session this player is
   * still pointed at is gone (restart dead window); the next `tick` holds
   * and reconnects rather than walking the fatal or sequence-stuck ladders
   * that would hammer the dead URL. Caller must only invoke this for
   * conventional live on an own proxy URL — LL and VOD keep their own paths.
   *
   * Clears any pending fatal/decode: a 404 that arrives after a media error
   * still means the session is gone, and the fatal ladder would only restart
   * the dead-window loop (Farol, PR 654).
   */
  onPlaylistGone(): void {
    this.playlistGone = true;
    this.pendingFatal = false;
    this.pendingDecodeError = false;
  }

  /**
   * The `<video>` element's own `error` event: the native engine, or an MSE
   * decode failure that bubbled past hls.js. `decode` is
   * `video.error?.code === MediaError.MEDIA_ERR_DECODE` — the one case the
   * ladder short-circuits, because `recoverMediaError()` is the one remedy
   * built for it and there is nothing to gain from trying the rest.
   */
  onNativeMediaError(input: { decode: boolean }): void {
    this.lastError = {
      type: "mediaElementError",
      details: input.decode ? "MEDIA_ERR_DECODE" : null,
      fatal: true,
      reason: null,
      message: null,
    };
    this.pendingFatal = true;
    if (input.decode) {
      this.pendingDecodeError = true;
    }
  }

  /** A new source was attached: forget the old playlist's timeline. */
  onSourceChanged(now: number): void {
    this.attachedAt = now;
    this.hasPlayed = false;
    this.jumpOffered = false;
    this.waitingSince = null;
    this.lastSequence = null;
    this.sequenceSeenAt = now;
    this.lastPartKey = null;
    this.partSeenAt = now;
    this.partStuckFired = false;
    this.pendingFatal = false;
    this.pendingDecodeError = false;
    this.playlistGone = false;
    this.heldForRestart = false;
    this.pendingMediaFatal = false;
    this.ladderStep = 0;
    // `mediaRebuilds` deliberately survives, for the same reason `rebuilds`
    // below does: a rebuild is what calls this, so resetting it here would
    // make the bound unreachable.
    // A genuine re-attach (a session that actually moved on) is the
    // recovery a stuck egress's reconnect budget exists to find -- reset it
    // along with the rest of the episode's state.
    this.reconnectAttempts = 0;
    this.nextReconnectAt = null;
    // `rebuilds` deliberately survives a mere re-attach: repeated instance
    // churn inside the dead-window is exactly what should end in `"dead"`
    // rather than another rebuild, and a rebuild is the only thing that
    // calls this.
  }

  /** The person pressed "try again": a clean slate, including the dead-window. */
  reset(now: number): void {
    this.rebuilds = [];
    this.mediaRebuilds = 0;
    this.lastError = null;
    this.onSourceChanged(now);
  }

  /** Why the last non-`"none"` `tick` fired, for the console and the UI. */
  lastReason: HlsStallReason = null;

  private currentReason(now: number): HlsStallReason {
    // Playlist-gone before fatal: a 404 on our own master is the restart
    // signal itself. Preferring fatal here would walk recoverMediaError /
    // startLoad after the player already stopLoad'd, reintroducing the
    // dead-window loop (Farol, PR 654). Soft stall/sequence rules stay
    // below so a gone session never waits them out either.
    if (this.playlistGone) {
      return "playlist-gone";
    }
    if (this.pendingFatal || this.pendingDecodeError) {
      return "fatal";
    }
    if (
      this.waitingSince !== null &&
      now - this.waitingSince >= this.stallMs &&
      !this.inStartupGrace(now)
    ) {
      return "stall";
    }
    if (
      this.sequenceSeenAt !== null &&
      this.lastSequence !== null &&
      now - this.sequenceSeenAt >= this.sequenceStuckMs &&
      // THE BACKSTOP, NOT THE RULE (production, 2026-09-16). On LL a part
      // arriving is proof the stream is alive; `EXT-X-MEDIA-SEQUENCE` only
      // moves when a closed segment leaves the window, which a remux that
      // closes on an IDR does every 5 to 9 s. While parts advance there is
      // nothing stuck to recover from, and the ladder's seeks and reloads
      // were cancelling the very part downloads that proved it. With no
      // part signal at all -- a conventional session, or an LL one whose
      // `LEVEL_UPDATED` has never carried a part -- this is unchanged.
      !this.partsAdvancing(now)
    ) {
      return "sequence-stuck";
    }
    return null;
  }

  tick(now: number): HlsStallDecision {
    if (this.attachedAt === null) {
      this.attachedAt = now;
    }
    const reason = this.currentReason(now);
    if (reason === null) {
      this.ladderStep = 0;
      // The part-stuck rule only ever gets a turn when nothing more urgent
      // (fatal, stall, or the segment-based sequence-stuck) is already
      // flagged -- it is a quick, early nudge for the case those slower
      // signals have not caught yet, never a competitor to them.
      if (
        this.partStuckMs !== null &&
        !this.partStuckFired &&
        // A PART THAT NEVER ARRIVED IS NOT A PART THAT STOPPED.
        // `onSourceChanged` stamps `partSeenAt` at the attach so the clock
        // has a start, but until `onPartAdvance` has actually reported one
        // there is nothing to be stuck: firing here nudged (`startLoad`) a
        // player that was merely still fetching its first manifest. The
        // grace below covers the seconds after that first part too, while
        // the buffer fills.
        this.lastPartKey !== null &&
        this.partSeenAt !== null &&
        now - this.partSeenAt >= this.partStuckMs &&
        !this.inStartupGrace(now)
      ) {
        this.partStuckFired = true;
        this.lastReason = "part-stuck";
        return "start-load";
      }
      return "none";
    }
    if (reason !== this.lastReason) {
      // Either a fresh episode, or a more specific reason just pre-empted a
      // milder one (a fatal error arriving mid-"stall"): either way the
      // ladder that applies changed, so start it over.
      this.ladderStep = 0;
      this.reconnectAttempts = 0;
      this.nextReconnectAt = null;
      this.heldForRestart = false;
    }
    this.lastReason = reason;
    this.ladderStep += 1;

    if (this.pendingDecodeError && this.ladderStep > 1) {
      // Step 1 (`recoverMediaError()`) already ran and the decode error is
      // still here: nothing else in the ladder fixes a broken decoder.
      return this.gateRebuild(now);
    }

    if (this.pendingMediaFatal) {
      // LL only (`classifyLlHlsError`): the pipeline cannot use the bytes it
      // was handed. One `recoverMediaError()`, then a BOUNDED rebuild --
      // `LL_HLS_MAX_MEDIA_REBUILDS` of them and the person gets the holding
      // screen with a retry button instead of a player that tears itself
      // down for the rest of the party. Never reachable on conventional:
      // `onError` only ever sets this flag under `mode === "ll"`, so the
      // restart hold above and the ladder below are untouched there.
      if (this.ladderStep === 1) {
        return "recover-media-error";
      }
      if (this.mediaRebuilds >= LL_HLS_MAX_MEDIA_REBUILDS) {
        return "dead";
      }
      this.mediaRebuilds += 1;
      return this.gateRebuild(now);
    }

    if (reason === "playlist-gone" || reason === "sequence-stuck") {
      // Conventional restart dead window: hold once, then reconnect. Never
      // the in-place start-load ladder -- that is the 1 Hz / last-segment
      // loop. LL sequence-stuck keeps the older ladder below.
      if (reason === "playlist-gone" || this.mode === "conventional") {
        if (!this.heldForRestart) {
          this.heldForRestart = true;
          return "hold";
        }
        // Pin the step so a long hold does not grow the cursor forever;
        // gateReconnect only cares about reconnectAttempts / backoff.
        this.ladderStep = 1;
        return this.gateReconnect(now);
      }
      const index = this.ladderStep - 1;
      if (index < SEQUENCE_STUCK_LADDER.length) {
        return SEQUENCE_STUCK_LADDER[index]!;
      }
      // The in-place ladder is spent and the egress is still not producing.
      // Ask whether the session moved on rather than rebuilding blind onto
      // the same dead source -- but bounded, not on every tick.
      this.ladderStep = SEQUENCE_STUCK_LADDER.length;
      return this.gateReconnect(now);
    }

    // "jump-live": see that decision's own doc comment. Offered ONCE per
    // attach (`jumpOffered`, not `ladderStep` -- `gateRebuild` resets the
    // latter every three cycles even with no real recovery, which without
    // this re-offered the jump every ~6-7 ticks instead of once), only LL,
    // only before this attach has ever painted a frame -- a stall
    // discovered after real playback started is the starved-presenter case
    // `classifyLlHlsError` already protects, and must keep walking the
    // ordinary ladder below exactly as it always has.
    if (
      reason === "stall" &&
      this.mode === "ll" &&
      !this.hasPlayed &&
      !this.jumpOffered
    ) {
      this.jumpOffered = true;
      return "jump-live";
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

  /**
   * Bounded, backed-off `"sequence-stuck"` reconnect checks (Farol review,
   * PR 570). Without this a stuck egress produced one `fetchChannelLive`
   * per tick (`STALL_TICK_MS`, ~1 s) for as long as it stayed stuck, with no
   * ceiling and no gap between overlapping requests once the API itself
   * slowed down. `"none"` in between checks is deliberate: the caller only
   * treats a non-`"none"` decision as new work, so a spaced-out wait must
   * not look like an in-place recovery step firing again.
   */
  private gateReconnect(now: number): HlsStallDecision {
    if (this.nextReconnectAt !== null && now < this.nextReconnectAt) {
      return "none";
    }
    if (this.reconnectAttempts >= this.maxReconnects) {
      // The server's own egress watchdog has had its budget and then some
      // -- including the last attempt's own backoff, just waited out above
      // -- so still stuck is no longer a "keep polling" condition. A
      // person's own "try again" (`reset()`) is the only thing that reopens
      // it.
      return "dead";
    }
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      this.reconnectBackoffMaxMs,
      this.reconnectBackoffMs * 2 ** (this.reconnectAttempts - 1),
    );
    this.nextReconnectAt = now + backoff;
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

/**
 * The YouTube player, as a shell with no opinions.
 *
 * WHAT THIS MODULE IS. An imperative surface over the IFrame Player API
 * (`load`, `play`, `pause`, `seek`, `setPlaybackRate`, `getPosition`,
 * `destroy`), a queue that runs the `PlayerCommand`s `state` hands it, and a
 * stream of flat facts back out. It executes and it reports.
 *
 * WHAT THIS MODULE DECIDES: nothing. Not whose action wins, not whether the
 * room has drifted, not whether an event came from a person or from a command
 * this file ran a moment ago. All of that is `lib/watch-party/state.ts`, and
 * `docs/WATCH_PARTY.md` explains why it has to be: echo suppression needs the
 * last state the room *adopted* and the drift ladder needs the remote state
 * next to the local position, and only `state` holds either. An echo guard
 * here would be a guard that cannot see what it is guarding against.
 *
 * That is also why the events below are phases and positions rather than
 * intents. "The player reached PLAYING" is a fact. "The user pressed play" is
 * a conclusion, and drawing it here would draw it in the wrong module.
 *
 * NO MEDIA TRACK EXISTS FOR THIS FEATURE. Each participant streams from
 * YouTube directly. There is no `MediaStream` and no `addTrack` in this file
 * and there must not be one: see `packages/shared/src/watch-party.ts`.
 *
 * THE PLAYER CHROME IS YOUTUBE'S AND STAYS THAT WAY. Nothing here hides,
 * overlays or restyles the controls, and nothing here goes near ads. Both
 * breach the IFrame Player API terms, which is a bad trade for a hobby project
 * that would like to keep the feature.
 *
 * WHY THERE IS A SEAM. The IFrame API only exists inside a browser with a real
 * document, and this repo's unit suite runs in `node` with no DOM at all (see
 * `client/vitest.config.ts`). So everything YouTube-specific sits behind
 * `CreateYouTubePlayer`, one injected function that the tests replace with a
 * fake. What is left is a queue, a mapping table and a clock comparison, all
 * of which can be exercised without a browser.
 *
 * THE VOCABULARY BELONGS TO `state.ts` AND IS IMPORTED, NOT REDECLARED. This
 * file once carried its own `PlayerEvent` and `PlayerCommand`, structurally
 * similar to the reducer's and disagreeing on three of five names, and the two
 * modules had consequently never exchanged a single event. `state` owns the
 * alphabet because `state` is the pure half and this one is the replaceable
 * half: a second player writes to the same alphabet, whereas a reducer that
 * imported from here would be rewritten for every new player. The full account
 * is in `docs/WATCH_PARTY.md` under "Two green suites can still not be a
 * feature". DO NOT REINTRODUCE A LOCAL COPY OF ANY OF THESE TYPES.
 */

import type {
  PlaybackFailureReason,
  PlaybackPhase,
  PlayerCommand,
  PlayerEvent,
  PlayerFailure,
} from "@/lib/watch-party/state";

/*
 * Re-exported so the failure card and the container can name these without
 * every component reaching past this module for a type it only ever sees
 * attached to a `PlayerFailure` this module produced. A type re-export, so
 * there is still exactly one declaration.
 */
export type {
  PlaybackFailureReason,
  PlaybackPhase,
  PlayerCommand,
  PlayerEvent,
  PlayerFailure,
};

/**
 * `onStateChange` codes, from the IFrame API.
 *
 * Written out rather than imported because there is nothing to import them
 * from: this repo pulls in no YouTube package and no `@types/youtube`, and the
 * API arrives at runtime from YouTube's own script tag.
 */
export const YOUTUBE_PLAYER_STATE = {
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const;

/** YouTube's state codes, in the words `state.ts` uses. */
export function phaseFromStateCode(code: number): PlaybackPhase {
  switch (code) {
    case YOUTUBE_PLAYER_STATE.ended:
      return "ended";
    case YOUTUBE_PLAYER_STATE.playing:
      return "playing";
    case YOUTUBE_PLAYER_STATE.paused:
      return "paused";
    case YOUTUBE_PLAYER_STATE.buffering:
      return "buffering";
    case YOUTUBE_PLAYER_STATE.cued:
      return "cued";
    default:
      return "unstarted";
  }
}

/* ------------------------------------------------------------------------- *
 * Failures.
 * ------------------------------------------------------------------------- */

const YOUTUBE_WATCH_BASE = "https://www.youtube.com/watch";

export function watchOnYouTubeUrl(
  videoId: string | null,
  positionMs = 0,
): string | null {
  if (!videoId) return null;
  const url = new URL(YOUTUBE_WATCH_BASE);
  url.searchParams.set("v", videoId);
  const seconds = Math.floor(Math.max(0, positionMs) / 1000);
  if (seconds > 0) url.searchParams.set("t", `${seconds}s`);
  return url.toString();
}

/**
 * YouTube's `onError` code, turned into something a person can act on.
 *
 * ONE CODE COVERS ALMOST EVERYTHING, MEASURED RATHER THAN ASSUMED. On
 * 2026-08-27 a real Chromium was driven against the real player from two
 * origins: `http://localhost`, and a genuine `https://pqp.gg` one so the iframe
 * saw a registered domain in the Referer. Embedding disabled, age restricted,
 * deleted, private, and an eleven character string that is not a video at all
 * ALL reported error 150. Not 101, not 100, not 2. A playable video on the same
 * harness reported nothing and played, which is what rules out the harness
 * rejecting everything. See `client/e2e/watch-party-youtube-reality.spec.ts`.
 *
 * So `notPlayable` is the arm that fires in practice, and its copy has to be
 * true of all five of those situations at once WITHOUT NAMING A CAUSE. A card
 * saying the uploader disabled embedding, shown to somebody who mistyped an id,
 * is a confident lie on the one branch that actually renders. That is why the
 * arm is no longer called `embedDisabled`: the old name invited someone to
 * narrow the copy back to match it.
 *
 * THE OTHER ARMS STAY AS DEFENSIVE HANDLING, NOT AS EXPECTED PATHS. 100, 2 and
 * 5 were not observed at all on that date. They are mapped anyway because
 * YouTube can change what it emits without telling anybody, and an unmapped
 * code falling through to a blank frame is worse than a card that is merely
 * unlikely. Do not read their presence as evidence that they occur.
 *
 * 153 IS DELIBERATELY KEPT SEPARATE even though QA could not provoke it either:
 * a document served with `Referrer-Policy: no-referrer` plays normally. It
 * stays its own arm because it is the one failure whose fix is environmental
 * rather than "watch it on YouTube", and because our own Cloudflare edge is the
 * likely cause if it ever does appear.
 *
 * `ageRestricted` IS IN THE UNION AND THIS FUNCTION NEVER RETURNS IT. Folklore
 * says 150 means age restriction. It does not; it means all five of the things
 * above, so wiring it would be wrong most of the time.
 */
export function describeYouTubeError(
  code: number,
  videoId: string | null,
  positionMs = 0,
): PlayerFailure {
  const reason: PlaybackFailureReason =
    code === 101 || code === 150
      ? "notPlayable"
      : code === 153
        ? "refererBlocked"
        : // 2 is an invalid parameter, which in practice is an id that is not a
          // video. From the reader's side that is the same situation as 100:
          // there is nothing at that id, and no retry will change it.
          code === 100 || code === 2
          ? "videoUnavailable"
          : "playerFailed";
  return {
    reason,
    code,
    videoId,
    environmental: reason === "refererBlocked",
    watchOnYouTubeUrl: watchOnYouTubeUrl(videoId, positionMs),
  };
}

/* ------------------------------------------------------------------------- *
 * Commands in, facts out.
 *
 * `PlayerCommand` and `PlayerEvent` are `state.ts`'s, imported at the top of
 * this file. What belongs here is the half of their contract that is a
 * measurement of the real player rather than a decision of the reducer's:
 *
 * WHICH CALLS PRODUCE NO EVENT AT ALL, measured in a browser and written down
 * because the suppression window in `state` is sized against exactly this list.
 * A latch waiting for one of these waits forever.
 *
 * - `seekTo` while PAUSED emits no event of any kind.
 * - `playVideo` on a video already playing emits nothing, and `pauseVideo` on
 *   one already paused likewise.
 * - A rate request that resolves to the rate already in force emits nothing.
 *
 * And what they produce when they do speak: every programmatic seek while
 * PLAYING fires BUFFERING then PLAYING, including a 50ms one, and
 * `getCurrentTime()` still answers the OLD position in that same synchronous
 * tick. A 50ms seek costs roughly a quarter second of buffering, so there is
 * no such thing as a cheap small seek.
 *
 * A `phase` event is emitted for a programmatic pause and a human pause
 * identically, because they are identical: the IFrame API offers nothing that
 * tells them apart, which is the whole reason the suppression lives in the
 * module that has the extra information.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- *
 * The seam.
 * ------------------------------------------------------------------------- */

/**
 * The part of `YT.Player` this module touches, and nothing else.
 *
 * Narrow on purpose. A fake that has to implement forty methods is a fake
 * nobody writes, and every method here is one a test needs to observe.
 */
export interface YouTubePlayerLike {
  loadVideoById(videoId: string, startSeconds?: number): void;
  cueVideoById(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  /** Seconds, per the IFrame API. This module converts at the boundary. */
  getCurrentTime(): number;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates?(): number[];
  /** Must leave no iframe behind. See `createYouTubeIframePlayer`. */
  destroy(): void;
}

export interface CreateYouTubePlayerOptions {
  /**
   * The container to mount into.
   *
   * A container, not the element to replace: `new YT.Player(el)` swaps `el`
   * out for the iframe, so anything handed straight in is gone afterwards and
   * teardown has nothing to empty. The real factory appends its own child.
   */
  host: HTMLElement;
  /** Loaded on construction, because the real API takes it there. */
  videoId: string | null;
  onStateChange(code: number): void;
  onError(code: number): void;
  onPlaybackRateChange(rate: number): void;
}

/**
 * The one function that knows YouTube exists.
 *
 * Rejecting means "there is no player and there will not be one", which the
 * shell turns into a reportable failure rather than an exception: one
 * participant whose script was blocked must not take the party down with them.
 */
export type CreateYouTubePlayer = (
  options: CreateYouTubePlayerOptions,
) => Promise<YouTubePlayerLike>;

/* ------------------------------------------------------------------------- *
 * Loading the IFrame API. The only browser-only code in the file.
 * ------------------------------------------------------------------------- */

const IFRAME_API_SRC = "https://www.youtube.com/iframe_api";

/**
 * How long to wait for YouTube's script before calling it a failure.
 *
 * `script.onerror` is not enough by itself. A content blocker can answer the
 * request with an empty 200, in which case the tag loads happily and
 * `onYouTubeIframeAPIReady` is simply never called, and a captive portal can
 * hold the socket open for minutes. Without a deadline the panel spins
 * forever, which is the worst available outcome because it tells the viewer
 * nothing at all.
 */
const API_LOAD_TIMEOUT_MS = 10_000;

/** How long to wait for `onReady` once the API itself has arrived. */
const PLAYER_READY_TIMEOUT_MS = 15_000;

interface YouTubeNamespace {
  Player: new (host: HTMLElement, options: unknown) => YouTubePlayerLike;
}

interface YouTubeGlobals {
  YT?: YouTubeNamespace;
  onYouTubeIframeAPIReady?: () => void;
}

let apiPromise: Promise<YouTubeNamespace> | null = null;

/**
 * Fetch YouTube's IFrame API, once per page.
 *
 * WHY THE GLOBAL CALLBACK IS CHAINED RATHER THAN ASSIGNED. The API signals
 * readiness by calling `window.onYouTubeIframeAPIReady`, a single global. If
 * anything else on the page ever wants the same API, whoever assigns last wins
 * and the other one hangs forever. Calling through to whatever was already
 * there costs one line and removes a whole class of "it worked until we added
 * an embed".
 *
 * WHY A FAILURE DROPS THE MEMO. A rejected promise that stays cached is a
 * failure that can never be retried, and the UI offers a retry for exactly
 * this case (see `refererBlocked` and `playerFailed` in the view module). The
 * injected tag goes with it, so the retry starts from a clean document rather
 * than waiting on a tag that already gave up.
 */
export function loadIframeApi(
  timeoutMs = API_LOAD_TIMEOUT_MS,
): Promise<YouTubeNamespace> {
  apiPromise ??= new Promise<YouTubeNamespace>((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new Error("watch party: no document to load the IFrame API into"));
      return;
    }

    const globals = window as unknown as YouTubeGlobals;
    if (globals.YT?.Player) {
      resolve(globals.YT);
      return;
    }

    let settled = false;
    let injected: HTMLScriptElement | null = null;

    const timer = setTimeout(() => {
      fail(new Error("watch party: the YouTube IFrame API did not load in time"));
    }, timeoutMs);

    function succeed(api: YouTubeNamespace): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(api);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      apiPromise = null;
      injected?.remove();
      reject(error);
    }

    const previous = globals.onYouTubeIframeAPIReady;
    globals.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (globals.YT?.Player) succeed(globals.YT);
      else fail(new Error("watch party: the IFrame API loaded without a Player"));
    };

    // Somebody else may have put the tag there already, in which case the
    // chained callback above is the whole subscription and adding a second tag
    // would only duplicate the download.
    if (document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) return;

    injected = document.createElement("script");
    injected.src = IFRAME_API_SRC;
    injected.async = true;
    injected.onerror = () => {
      fail(new Error("watch party: the YouTube IFrame API script failed to load"));
    };
    document.head.appendChild(injected);
  });
  return apiPromise;
}

/**
 * The real factory.
 *
 * `playerVars` is deliberately thin. `origin` is here because it is half of
 * what YouTube checks before it will answer at all, and getting it wrong is
 * one of the ways error 153 happens. Nothing here alters the controls or the
 * branding and nothing here goes near ads.
 *
 * TEARDOWN ACTUALLY RELEASES THE IFRAME, which is why the player is mounted
 * into a child of the caller's container rather than into the container
 * itself. `YT.Player` replaces the element it is given, so mounting directly
 * would destroy the caller's node and leave the iframe as its own replacement,
 * with nothing left holding a reference to empty. Emptying the container after
 * `destroy()` is the belt to that braces: a player that failed before it was
 * ready can leave its iframe behind, and an iframe that outlives the panel is
 * a video that keeps buffering in a channel nobody is in.
 */
export const createYouTubeIframePlayer: CreateYouTubePlayer = async (options) => {
  const api = await loadIframeApi();
  const host = options.host;
  const mount = document.createElement("div");
  host.appendChild(mount);

  const release = (player: YouTubePlayerLike | null) => {
    try {
      player?.destroy();
    } catch (error) {
      console.error("[watch-party] YT destroy threw", error);
    }
    host.replaceChildren();
  };

  return await new Promise<YouTubePlayerLike>((resolve, reject) => {
    let ready = false;
    let player: YouTubePlayerLike | null = null;

    const timer = setTimeout(() => {
      if (ready) return;
      release(player);
      reject(new Error("watch party: the player was never ready"));
    }, PLAYER_READY_TIMEOUT_MS);

    player = new api.Player(mount, {
      videoId: options.videoId ?? undefined,
      playerVars: {
        enablejsapi: 1,
        playsinline: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          ready = true;
          clearTimeout(timer);
          const live = player;
          if (!live) return;
          resolve({
            loadVideoById: (id, start) => live.loadVideoById(id, start),
            cueVideoById: (id, start) => live.cueVideoById(id, start),
            playVideo: () => live.playVideo(),
            pauseVideo: () => live.pauseVideo(),
            seekTo: (seconds, allow) => live.seekTo(seconds, allow),
            getCurrentTime: () => live.getCurrentTime(),
            setPlaybackRate: (rate) => live.setPlaybackRate(rate),
            getAvailablePlaybackRates: () =>
              live.getAvailablePlaybackRates?.() ?? [],
            destroy: () => release(live),
          });
        },
        onStateChange: (event: { data: number }) => {
          options.onStateChange(event.data);
        },
        onError: (event: { data: number }) => {
          // Forwarded even before `onReady`. A video that cannot be embedded
          // errors without ever becoming ready, and the viewer still needs the
          // sentence rather than a spinner.
          options.onError(event.data);
        },
        onPlaybackRateChange: (event: { data: number }) => {
          options.onPlaybackRateChange(event.data);
        },
      },
    });
  });
};

/* ------------------------------------------------------------------------- *
 * The shell.
 * ------------------------------------------------------------------------- */

/** How often the position is sampled, to notice a scrub. */
const POSITION_POLL_MS = 250;

/**
 * A position discontinuity this large is somebody scrubbing, not drift.
 *
 * THE ONLY THRESHOLD IN THIS FILE, and it is about the player's own clock
 * rather than about the room, which is why it survives the "no decisions"
 * rule. It says the position left the prediction, and nothing about who moved
 * it or what should happen next.
 *
 * MEASURED AGAINST THE PLAYER'S OWN PREDICTED POSITION, never against the
 * room's. That is what keeps a seek and a drift apart: drift is a slow
 * divergence from the room while the local position advances exactly as its
 * own last sample predicted, and a scrub is the position leaving its own
 * prediction between one poll and the next. Comparing against the room instead
 * would make a peer that fell three seconds behind announce its own lag as a
 * seek and drag everybody back to it.
 *
 * The floor is the longest rebuffer that can happen between two polls, which
 * is why `POSITION_POLL_MS` is a quarter of a second: every rebuffer and every
 * throttled background tab makes a small discontinuity, and flagging those
 * would flag noise continuously. Generous on purpose in the other direction
 * too. Over-flagging hands `state` a jump it may act on and yank the room;
 * under-flagging costs a second of drift, which the ladder `state` owns
 * absorbs on its own.
 *
 * IT LIVES HERE BECAUSE THE POLL LOOP LIVES HERE. `state` carried a second
 * copy of this number and a second detector once, fed by an event that was
 * never emitted; `docs/WATCH_PARTY.md` records how that survived two green
 * suites. One detector, one threshold.
 */
const SEEK_DETECT_MS = 2_000;

/**
 * The same question asked of a PAUSED player, where the answer is much sharper.
 *
 * `SEEK_DETECT_MS` is two seconds because of rebuffering: while playing, the
 * position can legitimately fall behind its prediction by however long the
 * network stalled between two polls, and flagging that would flag noise all
 * evening. NONE OF THAT REASONING APPLIES TO A PAUSED PLAYER. Its predicted
 * elapsed is exactly zero, it cannot rebuffer, and the position simply must not
 * move. Anything that moves it is a hand on the scrubber.
 *
 * So the tolerance here is float and sampling noise and nothing else, which is
 * why it is small and why it is not a measurement of YouTube: applying the
 * playing threshold to a paused player would be carrying over a number whose
 * justification does not travel with it, and it would quietly cost the room
 * every scrub shorter than two seconds made while the video is paused.
 */
const PAUSED_JUMP_MS = 150;

/** How many pre-ready commands to hold. See `queue`. */
const MAX_QUEUED_COMMANDS = 32;

export type PlayerPhase = "loading" | "ready" | "failed" | "destroyed";

export interface WatchPartyPlayerStatus {
  phase: PlayerPhase;
  videoId: string | null;
  playback: PlaybackPhase;
  playbackRate: number;
  /**
   * What YouTube's speed menu offers, empty until the player is ready.
   *
   * NOT THE SET OF LEGAL RATES, and do not clamp to it. The player accepts a
   * finer grid than it advertises; see `applyRate`. This is here because it is
   * a fact worth having, not because it is a constraint worth obeying.
   */
  availablePlaybackRates: number[];
  failure: PlayerFailure | null;
}

export interface WatchPartyPlayerOptions {
  /** The container the iframe is mounted inside. Emptied on teardown. */
  host: HTMLElement;
  /** Every fact, in order. Never a conclusion. */
  onEvent(event: PlayerEvent): void;
  onStatus?(status: WatchPartyPlayerStatus): void;
  /** The video to mount with, when the room already has one. */
  videoId?: string | null;
  /** Substituted in tests. Defaults to the real IFrame API. */
  createPlayer?: CreateYouTubePlayer;
  now?: () => number;
  positionPollMs?: number;
  seekDetectMs?: number;
}

export interface WatchPartyPlayer {
  /** Run one command from `state`, without interpreting it. */
  execute(command: PlayerCommand): void;
  /** Run several, in order. */
  executeAll(commands: readonly PlayerCommand[]): void;
  load(videoId: string, positionMs?: number): void;
  play(): void;
  pause(): void;
  seek(positionMs: number): void;
  setPlaybackRate(rate: number): void;
  /**
   * Milliseconds, or null when there is no player to ask.
   *
   * NULL RATHER THAN ZERO, DELIBERATELY. A failed or unmounted player has no
   * position, and answering 0 would be a number the caller cannot tell from a
   * video at the start. The wire contract spells out where that ends up:
   * position 0 on a fresh `rev` outranks the whole room and drags everybody
   * back to the beginning. Making the absence unmissable at the type level is
   * cheaper than remembering the rule.
   */
  getPosition(): number | null;
  /**
   * What YouTube's speed menu offers. See the note on `availablePlaybackRates`
   * in the status: this under-reports what the player accepts, and clamping a
   * requested rate to it would break the drift ladder rather than protect it.
   */
  getAvailablePlaybackRates(): number[];
  getStatus(): WatchPartyPlayerStatus;
  /** Idempotent. Leaves the host container empty. */
  destroy(): void;
}

/**
 * A listener throwing is the listener's problem, not the player's.
 *
 * Same reasoning as the WS handlers in `client/src/lib/realtime.ts`: one bad
 * subscriber must not be able to wedge the machinery that called it.
 */
function safely(run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error("[watch-party] listener threw", error);
  }
}

export function createWatchPartyPlayer(
  options: WatchPartyPlayerOptions,
): WatchPartyPlayer {
  const now = options.now ?? (() => Date.now());
  const positionPollMs = options.positionPollMs ?? POSITION_POLL_MS;
  const seekDetectMs = options.seekDetectMs ?? SEEK_DETECT_MS;
  const createPlayer = options.createPlayer ?? createYouTubeIframePlayer;

  let player: YouTubePlayerLike | null = null;
  let phase: PlayerPhase = "loading";
  let videoId: string | null = options.videoId ?? null;
  let playback: PlaybackPhase = "unstarted";
  let playbackRate = 1;
  let failure: PlayerFailure | null = null;

  /** Baseline for noticing a scrub. See `POSITION_JUMP_MS`. */
  let sample: { atMs: number; positionMs: number } | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Commands that arrived before the player existed.
   *
   * Held in order and flushed on ready, rather than collapsed to the last one.
   * `state` emits sequences whose steps are not interchangeable (`load` then
   * `seek` then `play` is the ordinary way a party starts) and keeping only
   * the newest would drop the load. The cap is there so a player that never
   * becomes ready cannot grow this without bound; past it the oldest goes,
   * because in a last-writer-wins feature the old ones are the ones a later
   * command has most likely already superseded.
   */
  const queue: PlayerCommand[] = [];

  function status(): WatchPartyPlayerStatus {
    return {
      phase,
      videoId,
      playback,
      playbackRate,
      availablePlaybackRates: availableRates(),
      failure,
    };
  }

  function announce(): void {
    const listener = options.onStatus;
    if (listener) safely(() => listener(status()));
  }

  function emit(event: PlayerEvent): void {
    safely(() => options.onEvent(event));
  }

  function availableRates(): number[] {
    try {
      return player?.getAvailablePlaybackRates?.() ?? [];
    } catch {
      return [];
    }
  }

  function readPosition(): number | null {
    if (!player || phase !== "ready") return null;
    try {
      const seconds = player.getCurrentTime();
      if (!Number.isFinite(seconds)) return null;
      return Math.max(0, seconds * 1000);
    } catch {
      // A player mid-teardown throws here. No answer is the honest answer.
      return null;
    }
  }

  function rebase(): void {
    const at = readPosition();
    sample = at === null ? null : { atMs: now(), positionMs: at };
  }

  function fail(next: PlayerFailure): void {
    if (phase === "destroyed" || phase === "failed") return;
    phase = "failed";
    failure = next;
    stopPolling();
    announce();
    emit({ kind: "failed", failure: next });
  }

  function onStateChange(code: number): void {
    if (phase === "destroyed") return;
    playback = phaseFromStateCode(code);
    // Rebase before reporting. A phase change is exactly when the position
    // stops following the previous prediction, and leaving the old baseline in
    // place would turn the next tick into a fabricated jump.
    const at = readPosition();
    sample = at === null ? null : { atMs: now(), positionMs: at };
    announce();
    emit({ kind: "phase", phase: playback, positionMs: at ?? 0 });
  }

  function onError(code: number): void {
    if (phase === "destroyed") return;
    fail(describeYouTubeError(code, videoId, readPosition() ?? 0));
  }

  /**
   * Say where the player is, and whether it got there the way its own clock
   * predicted.
   *
   * EVERY POLL EMITS, and that is the point rather than an inefficiency. Two
   * different consumers read this one event: the drift ladder needs a position
   * on every sample, and scrub handling needs the rare discontinuity. Emitting
   * only on a discontinuity starves the ladder in total silence, so the two
   * facts ride together and neither consumer can be left without input. This
   * feature has already shipped that failure pointing the other way, and
   * `docs/WATCH_PARTY.md` records it.
   *
   * There is no seek event in the IFrame API. A person dragging YouTube's
   * scrubber produces BUFFERING and then PLAYING, which at the event level is
   * indistinguishable from a rebuffer, so the clock is the only witness:
   * compare where the position should be against where it is.
   *
   * Buffering, cued and unstarted have no predictable position at all, so
   * those polls say nothing rather than something wrong. The baseline they
   * would otherwise poison is reset by the phase change itself, which is the
   * one moment the position provably stops following the previous prediction.
   *
   * A MISSING BASELINE IS REPORTED AS "NO JUMP", NEVER AS A JUMP, and that is
   * this module's suppression of its own seeks: `run` drops the baseline the
   * instant it issues one, so the next poll re-establishes it and cannot
   * accuse anybody of the seek we just performed. It is the only such
   * suppression in the feature now. `state` kept a second one, and it was
   * deleted along with the detector it served, because two stacked windows
   * swallow a real user action that lands in the gap between them.
   */
  function poll(): void {
    if (phase !== "ready") return;
    if (playback !== "playing" && playback !== "paused") return;
    const actual = readPosition();
    if (actual === null) return;
    const at = now();
    if (!sample) {
      sample = { atMs: at, positionMs: actual };
      emit({ kind: "position", positionMs: actual, jumpedFromMs: null });
      return;
    }
    const elapsed = playback === "playing" ? (at - sample.atMs) * playbackRate : 0;
    const expected = sample.positionMs + elapsed;
    sample = { atMs: at, positionMs: actual };
    const tolerance = playback === "playing" ? seekDetectMs : PAUSED_JUMP_MS;
    const jumped = Math.abs(actual - expected) > tolerance;
    emit({
      kind: "position",
      positionMs: actual,
      jumpedFromMs: jumped ? expected : null,
    });
  }

  function startPolling(): void {
    if (pollTimer !== null || positionPollMs <= 0) return;
    pollTimer = setInterval(poll, positionPollMs);
  }

  function stopPolling(): void {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /**
   * Every call into YouTube goes through here.
   *
   * A player that throws is not a party that ends. The IFrame API throws from
   * ordinary methods when the iframe has gone away underneath it, which
   * happens on teardown races and on a tab the browser discarded, and letting
   * that escape would take out whatever loop in `state` was flushing commands.
   */
  function attempt(what: string, run: (live: YouTubePlayerLike) => void): void {
    if (!player || phase !== "ready") return;
    try {
      run(player);
    } catch (error) {
      console.error(`[watch-party] ${what} threw`, error);
    }
  }

  function run(command: PlayerCommand): void {
    if (phase === "destroyed" || phase === "failed") return;
    if (phase !== "ready" || !player) {
      if (queue.length >= MAX_QUEUED_COMMANDS) queue.shift();
      queue.push(command);
      return;
    }
    switch (command.kind) {
      case "load": {
        videoId = command.videoId;
        failure = null;
        // LOADING RESETS THE RATE TO 1 AND SAYS NOTHING ABOUT IT.
        // `loadVideoById` and `cueVideoById` both do it, `seekTo` does not,
        // and no `onPlaybackRateChange` follows. Holding the old value here
        // would leave a cached 1.05 describing a player running at 1, which
        // fails in the nastiest available shape: drift correction that works
        // on the first video of the evening and quietly stops working on the
        // second. The event goes out because the rate genuinely changed and
        // this is the only place that can know it did.
        const rateBefore = playbackRate;
        playbackRate = 1;
        // Cue rather than load. Cueing mounts the video and waits, which is
        // the state a "join watch party" click wants behind it, and it does
        // not spend the viewer's data on a stream they have not asked for.
        // Whether to play afterwards is a separate command, from the module
        // that knows whether the room is playing.
        attempt("cueVideoById", (live) =>
          live.cueVideoById(command.videoId, Math.max(0, command.positionMs) / 1000),
        );
        announce();
        if (rateBefore !== 1) emit({ kind: "rate", rate: 1 });
        break;
      }
      case "play":
        attempt("playVideo", (live) => live.playVideo());
        break;
      case "pause":
        attempt("pauseVideo", (live) => live.pauseVideo());
        break;
      case "seek":
        attempt("seekTo", (live) =>
          live.seekTo(Math.max(0, command.positionMs) / 1000, true),
        );
        // The prediction is void the moment a seek is issued, and the events
        // it produces arrive before the seek lands. Dropping the baseline is
        // what stops the next tick reporting the transient as a jump.
        sample = null;
        break;
      case "setRate":
        applyRate(command.rate);
        break;
    }
  }

  /**
   * Ask the player for a rate. Ask, and do not negotiate on anybody's behalf.
   *
   * WHAT THE PLAYER ACTUALLY ACCEPTS, MEASURED RATHER THAN READ. The API
   * reference says an unsupported rate is "rounded down to the nearest
   * supported value in the direction of 1", and it is easy to read that as
   * meaning the list from `getAvailablePlaybackRates()` is the set of legal
   * values. It is not. That list is what the speed menu shows, and it
   * under-reports: the player quantises to a 0.05 grid, floored, clamped to
   * [0.25, 2]. So 0.95 and 1.05 are both real rates that the menu never
   * mentions.
   *
   * The consequence is asymmetric and was nearly shipped. Asking for 1.03
   * floors to 1, which is the rate already in force, so nothing changes and
   * `onPlaybackRateChange` never fires at all. Asking for 0.97 floors to 0.95,
   * which does change, so it does fire. A ladder built on that pair corrects
   * drift in one direction and silently does nothing in the other.
   *
   * THIS MODULE DOES NOT ROUND THE REQUEST TO FIT. An earlier version snapped
   * to the nearest entry of that under-reporting list, which is one module
   * quietly overturning a decision another module made, and it would also have
   * hidden the no-op above. `state` asks for what it wants and owns the grid.
   *
   * The local rate is updated ONLY from `onPlaybackRateChange`, never
   * optimistically here. That is what makes a refused rate visible instead of
   * silent, and it is what a caller feature-detecting the grid reads back.
   * A refusal and an event still in flight look the same in the same tick and
   * there is nothing here that can tell them apart; one tick later they are
   * distinguishable, because a refusal never produces an event at all while an
   * accepted rate always does.
   */
  function applyRate(rate: number): void {
    attempt("setPlaybackRate", (live) => live.setPlaybackRate(rate));
  }

  createPlayer({
    host: options.host,
    videoId,
    onStateChange,
    onError,
    onPlaybackRateChange: (rate) => {
      playbackRate = rate;
      rebase();
      announce();
      emit({ kind: "rate", rate });
    },
  })
    .then((created) => {
      if (phase === "destroyed") {
        // Torn down while the script was still in flight. Nothing else will
        // ever hold this player, so it has to be released here or the iframe
        // outlives the panel that asked for it.
        try {
          created.destroy();
        } catch {
          // A player that never finished starting can throw on destroy.
        }
        return;
      }
      player = created;
      phase = "ready";
      rebase();
      startPolling();
      announce();
      emit({ kind: "ready" });
      const pending = queue.splice(0, queue.length);
      for (const command of pending) run(command);
    })
    .catch((error: unknown) => {
      if (phase === "destroyed") return;
      // One participant losing YouTube is not the room losing YouTube. This
      // becomes a reportable failure, never a rejection nobody is awaiting.
      console.error("[watch-party] the IFrame API is unavailable", error);
      fail({
        reason: "playerFailed",
        code: null,
        videoId,
        // The script, not the video. A retry is worth offering and telling
        // somebody to pick a different video would be a lie.
        environmental: true,
        watchOnYouTubeUrl: watchOnYouTubeUrl(videoId),
      });
    });

  return {
    execute: run,

    executeAll(commands) {
      for (const command of commands) run(command);
    },

    load(id, positionMs = 0) {
      run({ kind: "load", videoId: id, positionMs });
    },

    play() {
      run({ kind: "play" });
    },

    pause() {
      run({ kind: "pause" });
    },

    seek(positionMs) {
      run({ kind: "seek", positionMs });
    },

    setPlaybackRate(rate) {
      run({ kind: "setRate", rate });
    },

    getPosition: readPosition,

    getAvailablePlaybackRates: availableRates,

    getStatus: status,

    destroy() {
      if (phase === "destroyed") return;
      phase = "destroyed";
      queue.length = 0;
      stopPolling();
      sample = null;
      const closing = player;
      player = null;
      try {
        closing?.destroy();
      } catch (error) {
        console.error("[watch-party] destroy threw", error);
      }
      announce();
    },
  };
}

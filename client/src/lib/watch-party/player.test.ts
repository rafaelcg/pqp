import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWatchPartyPlayer,
  describeYouTubeError,
  phaseFromStateCode,
  watchOnYouTubeUrl,
  YOUTUBE_PLAYER_STATE,
  type CreateYouTubePlayer,
  type CreateYouTubePlayerOptions,
  type PlaybackFailureReason,
  type PlayerEvent,
  type WatchPartyPlayer,
  type WatchPartyPlayerStatus,
  type YouTubePlayerLike,
} from "./player";

/**
 * The imperative shell, exercised against a fake handle.
 *
 * WHAT THESE TESTS CAN AND CANNOT SEE. The IFrame API needs a browser and this
 * suite runs in `node` (see `client/vitest.config.ts`), so nothing here proves
 * that YouTube behaves as documented. What it proves is everything on this side
 * of the seam: that commands reach the handle unaltered, that events come back
 * unaltered, that every error code lands on the sentence the UI expects, and
 * that a teardown releases what it claims to.
 *
 * WHAT IS NOT TESTED HERE, ON PURPOSE. Echo suppression. It moved to
 * `state.ts`, which is the only module holding the last adopted state, and the
 * test that fails when it is removed belongs next to it. What this file pins is
 * the other half of that boundary: this module reports a phase change it caused
 * itself exactly as loudly as one a person caused, because deciding which was
 * which is not its job. Reintroduce a guard here and `reports the phase change
 * caused by its own command` goes red.
 */

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

class FakeYouTubePlayer implements YouTubePlayerLike {
  calls: string[] = [];
  currentTimeSeconds = 0;
  rates: number[] | null = RATES;
  destroyed = 0;
  /** Set to make the handle throw the way a torn down iframe does. */
  throwing = false;

  private record(call: string): void {
    if (this.throwing) throw new Error("the iframe has gone away");
    this.calls.push(call);
  }

  loadVideoById(videoId: string, startSeconds?: number): void {
    this.record(`loadVideoById:${videoId}:${startSeconds ?? ""}`);
  }
  cueVideoById(videoId: string, startSeconds?: number): void {
    this.record(`cueVideoById:${videoId}:${startSeconds ?? ""}`);
  }
  playVideo(): void {
    this.record("playVideo");
  }
  pauseVideo(): void {
    this.record("pauseVideo");
  }
  seekTo(seconds: number, allowSeekAhead: boolean): void {
    this.record(`seekTo:${seconds}:${allowSeekAhead}`);
  }
  getCurrentTime(): number {
    if (this.throwing) throw new Error("the iframe has gone away");
    return this.currentTimeSeconds;
  }
  setPlaybackRate(rate: number): void {
    this.record(`setPlaybackRate:${rate}`);
  }
  getAvailablePlaybackRates(): number[] {
    return this.rates ?? [];
  }
  destroy(): void {
    this.destroyed += 1;
  }
}

interface Harness {
  player: WatchPartyPlayer;
  handle: FakeYouTubePlayer;
  events: PlayerEvent[];
  statuses: WatchPartyPlayerStatus[];
  /** Drive the callbacks the real API would call. */
  hooks(): CreateYouTubePlayerOptions;
  /** Let the injected factory resolve, then flush the microtasks it queued. */
  ready(): Promise<void>;
  /** Let the injected factory reject, as a blocked script does. */
  unavailable(): Promise<void>;
  clock: { ms: number };
  hostChildren: number;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function harness(
  options: {
    videoId?: string | null;
    positionPollMs?: number;
    seekDetectMs?: number;
    onEvent?: (event: PlayerEvent) => void;
  } = {},
): Harness {
  const events: PlayerEvent[] = [];
  const statuses: WatchPartyPlayerStatus[] = [];
  const handle = new FakeYouTubePlayer();
  const clock = { ms: 1_000 };

  let captured: CreateYouTubePlayerOptions | null = null;
  let settle: ((player: YouTubePlayerLike) => void) | null = null;
  let refuse: ((reason: unknown) => void) | null = null;

  const createPlayer: CreateYouTubePlayer = (opts) => {
    captured = opts;
    return new Promise<YouTubePlayerLike>((resolve, reject) => {
      settle = resolve;
      refuse = reject;
    });
  };

  const player = createWatchPartyPlayer({
    // No DOM in this suite, and the shell never touches the host: only the
    // real factory does, which is the point of the seam.
    host: {} as HTMLElement,
    videoId: options.videoId,
    createPlayer,
    now: () => clock.ms,
    positionPollMs: options.positionPollMs,
    seekDetectMs: options.seekDetectMs,
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
    onStatus: (status) => statuses.push(status),
  });

  return {
    player,
    handle,
    events,
    statuses,
    clock,
    hostChildren: 0,
    hooks: () => {
      if (!captured) throw new Error("the factory was never called");
      return captured;
    },
    ready: async () => {
      settle?.(handle);
      await flush();
    },
    unavailable: async () => {
      refuse?.(new Error("blocked"));
      await flush();
    },
  };
}

/** The codes the IFrame API can hand back, and the sentence each has to become. */
const ERROR_CODES: [number, PlaybackFailureReason][] = [
  [2, "videoUnavailable"],
  [5, "playerFailed"],
  [100, "videoUnavailable"],
  [101, "notPlayable"],
  [150, "notPlayable"],
  [153, "refererBlocked"],
  [1_000, "playerFailed"],
];

describe("phaseFromStateCode", () => {
  it("names every code the API documents, and treats anything else as unstarted", () => {
    expect(phaseFromStateCode(YOUTUBE_PLAYER_STATE.unstarted)).toBe("unstarted");
    expect(phaseFromStateCode(YOUTUBE_PLAYER_STATE.ended)).toBe("ended");
    expect(phaseFromStateCode(YOUTUBE_PLAYER_STATE.playing)).toBe("playing");
    expect(phaseFromStateCode(YOUTUBE_PLAYER_STATE.paused)).toBe("paused");
    expect(phaseFromStateCode(YOUTUBE_PLAYER_STATE.buffering)).toBe("buffering");
    expect(phaseFromStateCode(YOUTUBE_PLAYER_STATE.cued)).toBe("cued");
    expect(phaseFromStateCode(4)).toBe("unstarted");
  });
});

describe("describeYouTubeError", () => {
  it.each(ERROR_CODES)("maps %i onto %s", (code, reason) => {
    expect(describeYouTubeError(code, "abc").reason).toBe(reason);
  });

  /**
   * 153 is the whole reason this mapping is a table rather than a boolean.
   *
   * Every other refusal here means "pick a different video". A missing Referer
   * means the video is fine and the deployment is not, so a card that reads
   * like the others sends somebody off to fail four more times.
   */
  it("marks only the missing Referer as environmental", () => {
    for (const [code] of ERROR_CODES) {
      expect(describeYouTubeError(code, "abc").environmental).toBe(code === 153);
    }
  });

  /**
   * The honest gap, pinned so nobody quietly closes it with folklore.
   *
   * Age restriction and uploader-disabled embedding arrive as the same two
   * codes and the only thing that separates them is the Data API, which this
   * feature does not use. If a future change starts returning `ageRestricted`
   * from a code, this goes red and the reasoning has to be written down rather
   * than guessed at.
   */
  it("never claims age restriction, because no code carries that fact", () => {
    for (let code = -10; code <= 200; code += 1) {
      expect(describeYouTubeError(code, "abc").reason).not.toBe("ageRestricted");
    }
  });

  it("carries an escape hatch with the position on it", () => {
    const failure = describeYouTubeError(101, "dQw4w9WgXcQ", 95_000);
    expect(failure.watchOnYouTubeUrl).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s",
    );
    expect(describeYouTubeError(101, null).watchOnYouTubeUrl).toBeNull();
  });
});

describe("watchOnYouTubeUrl", () => {
  it("omits a timestamp that would land at zero", () => {
    expect(watchOnYouTubeUrl("abc", 400)).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });
});

describe("running commands", () => {
  it("passes each command to the handle without interpreting it", async () => {
    const h = harness();
    await h.ready();
    h.player.load("abc", 30_000);
    h.player.play();
    h.player.seek(12_500);
    h.player.pause();
    expect(h.handle.calls).toEqual([
      "cueVideoById:abc:30",
      "playVideo",
      "seekTo:12.5:true",
      "pauseVideo",
    ]);
  });

  it("runs a batch in the order it was given", async () => {
    const h = harness();
    await h.ready();
    h.player.executeAll([
      { kind: "load", videoId: "abc", positionMs: 0 },
      { kind: "seek", positionMs: 1_000 },
      { kind: "play" },
    ]);
    expect(h.handle.calls).toEqual(["cueVideoById:abc:0", "seekTo:1:true", "playVideo"]);
  });

  it("holds commands that arrive before the player exists, then runs them in order", async () => {
    const h = harness();
    h.player.load("abc", 0);
    h.player.play();
    expect(h.handle.calls).toEqual([]);
    await h.ready();
    expect(h.events[0]).toEqual({ kind: "ready" });
    expect(h.handle.calls).toEqual(["cueVideoById:abc:0", "playVideo"]);
  });

  it("caps the backlog, dropping the oldest rather than growing without bound", async () => {
    const h = harness();
    for (let i = 0; i < 40; i += 1) h.player.seek(i * 1_000);
    await h.ready();
    expect(h.handle.calls).toHaveLength(32);
    expect(h.handle.calls[0]).toBe("seekTo:8:true");
    expect(h.handle.calls.at(-1)).toBe("seekTo:39:true");
  });

  it("survives a handle that throws the way a torn down iframe does", async () => {
    const h = harness();
    await h.ready();
    h.handle.throwing = true;
    expect(() => h.player.play()).not.toThrow();
  });
});

describe("reporting what the player did", () => {
  /**
   * The boundary, as a test.
   *
   * A programmatic pause and a human pause produce the same event, and this
   * module reports both. Anything that quietly swallowed the first would be
   * making a decision it does not have the information to make, and the guard
   * that does have it lives in `state.ts`.
   */
  it("reports the phase change caused by its own command", async () => {
    const h = harness();
    await h.ready();
    h.player.pause();
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.paused);
    expect(h.events).toContainEqual({
      kind: "phase",
      phase: "paused",
      positionMs: 0,
    });
  });

  it("reports the stale position a seek's own events carry, without correcting it", async () => {
    const h = harness();
    await h.ready();
    h.handle.currentTimeSeconds = 10;
    h.player.seek(30_000);
    // The IFrame API fires these before the seek lands, so the player still
    // answers the old position. Reporting it as it is, rather than papering
    // over it, is what lets `state` apply its window to the transient.
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.buffering);
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    const phases = h.events.filter((event) => event.kind === "phase");
    expect(phases).toEqual([
      { kind: "phase", phase: "buffering", positionMs: 10_000 },
      { kind: "phase", phase: "playing", positionMs: 10_000 },
    ]);
  });

  it("keeps a throwing listener from wedging the player", async () => {
    const seen: PlayerEvent[] = [];
    const h = harness({
      onEvent: (event) => {
        seen.push(event);
        throw new Error("the panel blew up");
      },
    });
    await h.ready();
    expect(() =>
      h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing),
    ).not.toThrow();
    expect(seen).toHaveLength(2);
  });
});

describe("playback rate", () => {
  /**
   * The regression test for a boundary leak that was really there.
   *
   * An earlier version rounded the request to the nearest rate YouTube offers,
   * so `state` asking for 1.03 silently got 1. That is one module overturning
   * another module's decision, and it hid the very no-op it was reacting to.
   * Ask for exactly what you were told to ask for.
   */
  it("asks for exactly the rate it was given, off-menu values included", async () => {
    const h = harness();
    await h.ready();
    // 0.95 and 1.05 are real rates the speed menu never lists, which is why
    // clamping to `getAvailablePlaybackRates()` here would break the caller.
    h.player.setPlaybackRate(0.95);
    h.player.setPlaybackRate(1.05);
    h.player.setPlaybackRate(1.03);
    expect(h.handle.calls).toEqual([
      "setPlaybackRate:0.95",
      "setPlaybackRate:1.05",
      "setPlaybackRate:1.03",
    ]);
  });

  it("does not claim a rate the player never confirmed", async () => {
    const h = harness();
    await h.ready();
    h.player.setPlaybackRate(1.03);
    // No `onPlaybackRateChange`, which is what a refused rate looks like.
    expect(h.player.getStatus().playbackRate).toBe(1);
    expect(h.events.some((event) => event.kind === "rate")).toBe(false);
  });

  it("reports a rate the player did take, whoever asked for it", async () => {
    const h = harness();
    await h.ready();
    h.hooks().onPlaybackRateChange(1.25);
    expect(h.events).toContainEqual({ kind: "rate", rate: 1.25 });
    expect(h.player.getStatus().playbackRate).toBe(1.25);
  });

  /**
   * The failure this pins is intermittent by nature, which is the worst kind.
   *
   * Loading resets the player to rate 1 and fires no event saying so. A cached
   * 1.05 surviving that describes a player running at 1, and the symptom is
   * drift correction that works on the first video of the evening and stops
   * working on the second.
   */
  it("forgets the rate across a load, because the player does", async () => {
    const h = harness();
    await h.ready();
    h.hooks().onPlaybackRateChange(1.05);
    expect(h.player.getStatus().playbackRate).toBe(1.05);
    h.player.load("abc", 0);
    expect(h.player.getStatus().playbackRate).toBe(1);
    expect(h.events.at(-1)).toEqual({ kind: "rate", rate: 1 });
  });

  it("says nothing about a reset that changed nothing", async () => {
    const h = harness();
    await h.ready();
    h.player.load("abc", 0);
    expect(h.events.filter((event) => event.kind === "rate")).toEqual([]);
  });

  it("puts the rates on offer where the caller can adapt to them", async () => {
    const h = harness();
    await h.ready();
    expect(h.player.getAvailablePlaybackRates()).toEqual(RATES);
    expect(h.player.getStatus().availablePlaybackRates).toEqual(RATES);
  });
});

describe("position", () => {
  it("answers null rather than zero when there is nothing to ask", async () => {
    const h = harness();
    expect(h.player.getPosition()).toBeNull();
    await h.ready();
    h.handle.currentTimeSeconds = 42;
    expect(h.player.getPosition()).toBe(42_000);
    h.player.destroy();
    expect(h.player.getPosition()).toBeNull();
  });

  it("answers null when the handle throws", async () => {
    const h = harness();
    await h.ready();
    h.handle.throwing = true;
    expect(h.player.getPosition()).toBeNull();
  });
});

describe("noticing a scrub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(h: Harness, ms: number): void {
    h.clock.ms += ms;
    h.handle.currentTimeSeconds += ms / 1000;
    vi.advanceTimersByTime(ms);
  }

  it("says nothing while the position follows the clock", async () => {
    const h = harness({ positionPollMs: 100, seekDetectMs: 1_000 });
    await h.ready();
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    for (let i = 0; i < 20; i += 1) advance(h, 100);
    const positions = h.events.filter((event) => event.kind === "position");
    // THE FIRST ASSERTION IS THE ONE THAT WOULD OTHERWISE BE VACUOUS. "No event
    // carried a jump" is trivially true of a player that emits nothing at all,
    // and a player that emits nothing at all is the shape this feature already
    // shipped once: the drift ladder is fed by these events and starves in
    // silence without them.
    expect(positions.length).toBe(20);
    expect(positions.every((event) => event.jumpedFromMs === null)).toBe(true);
  });

  it("reports a position on every poll, jump or no jump", async () => {
    // The ladder's whole input. Emitting only on a discontinuity leaves it with
    // nothing to correct from, which is invisible until somebody notices the
    // room never converges. Pinned separately from the assertion above because
    // this is the property, and that one is a scenario.
    const h = harness({ positionPollMs: 100, seekDetectMs: 1_000 });
    await h.ready();
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    const before = h.events.filter((event) => event.kind === "position").length;
    for (let i = 0; i < 5; i += 1) advance(h, 100);
    const after = h.events.filter((event) => event.kind === "position").length;
    expect(after - before).toBe(5);
  });

  it("reports a position the clock did not predict", async () => {
    const h = harness({ positionPollMs: 100, seekDetectMs: 1_000 });
    await h.ready();
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    advance(h, 100);
    // A hand on YouTube's own scrubber, which the API reports as nothing.
    h.handle.currentTimeSeconds = 300;
    advance(h, 100);
    const jump = h.events.find(
      (event) => event.kind === "position" && event.jumpedFromMs !== null,
    );
    expect(jump).toBeDefined();
    if (jump?.kind === "position") {
      expect(jump.positionMs).toBeCloseTo(300_100, 0);
      // The prediction it left, not merely the fact that it left one. A jump
      // that cannot say where it came from cannot say how big it was.
      expect(jump.jumpedFromMs).toBeCloseTo(200, 0);
    }
  });

  it("does not manufacture a jump out of a buffering stall", async () => {
    const h = harness({ positionPollMs: 100, seekDetectMs: 1_000 });
    await h.ready();
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    advance(h, 100);
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.buffering);
    // Ten seconds of wall clock with the video frozen, which is what a stall is.
    for (let i = 0; i < 100; i += 1) {
      h.clock.ms += 100;
      vi.advanceTimersByTime(100);
    }
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    advance(h, 100);
    expect(
      h.events.some(
        (event) => event.kind === "position" && event.jumpedFromMs !== null,
      ),
    ).toBe(false);
  });

  it("does not report its own seek as a jump", async () => {
    const h = harness({ positionPollMs: 100, seekDetectMs: 1_000 });
    await h.ready();
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    advance(h, 100);
    h.player.seek(600_000);
    h.handle.currentTimeSeconds = 600;
    advance(h, 100);
    // THE ONLY SEEK SUPPRESSION IN THE FEATURE. `state` kept a second one and
    // it was deleted with the detector it served: two stacked windows swallow a
    // genuine user action that lands in the gap between them.
    expect(
      h.events.some(
        (event) => event.kind === "position" && event.jumpedFromMs !== null,
      ),
    ).toBe(false);
  });

  it("holds a paused player to a much tighter tolerance than a playing one", async () => {
    /**
     * A PAUSED PLAYER CANNOT REBUFFER, so the two-second threshold's whole
     * justification goes away and taking it with us would be carrying a number
     * past the reasoning that produced it. What it would cost is concrete: a
     * scrub of under two seconds made while the video is paused would never
     * reach the room at all, and this peer would then be quietly seeked back to
     * where the room still is.
     *
     * The same nudge while PLAYING is inside the rebuffer allowance and stays
     * unflagged, which is the half of this that stops the tolerance being
     * "smaller is better".
     */
    const jumps = (h: Harness) =>
      h.events.filter(
        (event) => event.kind === "position" && event.jumpedFromMs !== null,
      ).length;

    const held = harness({ positionPollMs: 100, seekDetectMs: 2_000 });
    await held.ready();
    held.hooks().onStateChange(YOUTUBE_PLAYER_STATE.paused);
    advance(held, 100);
    // Paused, so `advance` must not carry the position with the clock: the
    // point is that the position moved when nothing should have moved it.
    held.clock.ms += 100;
    held.handle.currentTimeSeconds += 0.5;
    vi.advanceTimersByTime(100);
    expect(jumps(held)).toBe(1);

    const playing = harness({ positionPollMs: 100, seekDetectMs: 2_000 });
    await playing.ready();
    playing.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    advance(playing, 100);
    playing.clock.ms += 100;
    // The same half second, while playing: a stall of that length is ordinary
    // and flagging it would flag noise all evening.
    playing.handle.currentTimeSeconds += 0.5;
    vi.advanceTimersByTime(100);
    expect(jumps(playing)).toBe(0);
  });

  it("stops sampling once the player is gone", async () => {
    const h = harness({ positionPollMs: 100, seekDetectMs: 1_000 });
    await h.ready();
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    h.player.destroy();
    const before = h.events.length;
    vi.advanceTimersByTime(5_000);
    expect(h.events).toHaveLength(before);
  });
});

describe("failing", () => {
  it("turns a code into a reportable failure and stops being a writer", async () => {
    const h = harness();
    await h.ready();
    h.hooks().onError(101);
    expect(h.events.at(-1)).toMatchObject({
      kind: "failed",
      failure: { reason: "notPlayable", code: 101 },
    });
    expect(h.player.getStatus().phase).toBe("failed");
    // A failed player has no position, which is the point: position zero on a
    // fresh rev would outrank the room and drag everybody back to the start.
    expect(h.player.getPosition()).toBeNull();
    const calls = h.handle.calls.length;
    h.player.play();
    expect(h.handle.calls).toHaveLength(calls);
  });

  it("reports a failure once, however many times the API repeats itself", async () => {
    const h = harness();
    await h.ready();
    h.hooks().onError(153);
    h.hooks().onError(153);
    expect(h.events.filter((event) => event.kind === "failed")).toHaveLength(1);
  });

  /**
   * The script never arriving is a failure of ours, not of the video.
   *
   * It has to become a status the panel can render rather than an unhandled
   * rejection, because one participant behind a content blocker must not take
   * the party down with them.
   */
  it("turns a blocked IFrame API into a failure rather than a rejection", async () => {
    const h = harness({ videoId: "abc" });
    h.player.play();
    await h.unavailable();
    expect(h.events).toEqual([
      {
        kind: "failed",
        failure: {
          reason: "playerFailed",
          code: null,
          videoId: "abc",
          environmental: true,
          watchOnYouTubeUrl: "https://www.youtube.com/watch?v=abc",
        },
      },
    ]);
    expect(h.player.getStatus().phase).toBe("failed");
  });
});

describe("teardown", () => {
  it("releases the handle exactly once, however often it is asked", async () => {
    const h = harness();
    await h.ready();
    h.player.destroy();
    h.player.destroy();
    expect(h.handle.destroyed).toBe(1);
    expect(h.player.getStatus().phase).toBe("destroyed");
  });

  it("releases a player that turns up after the panel has gone", async () => {
    const h = harness();
    h.player.destroy();
    await h.ready();
    expect(h.handle.destroyed).toBe(1);
  });

  it("ignores commands after teardown", async () => {
    const h = harness();
    await h.ready();
    h.player.destroy();
    h.player.play();
    h.player.seek(1_000);
    expect(h.handle.calls).toEqual([]);
  });

  it("ignores events that arrive after teardown", async () => {
    const h = harness();
    await h.ready();
    h.player.destroy();
    const before = h.events.length;
    h.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    h.hooks().onError(101);
    expect(h.events).toHaveLength(before);
  });
});

/**
 * Getting YouTube's script into the page, and what happens when it never comes.
 *
 * WHY THIS IS FAKED RATHER THAN SKIPPED. The script failing is not an exotic
 * case: a content blocker, a corporate proxy or an offline laptop all produce
 * it, and the panel has to say something honest instead of spinning. The DOM
 * this needs is three methods wide, so standing it up costs less than leaving
 * the failure path unpinned.
 *
 * The module memoises the API promise, so every test here reimports it after
 * `vi.resetModules()` to get a fresh one.
 */
describe("loadIframeApi", () => {
  interface FakeScript {
    src: string;
    async: boolean;
    onerror: (() => void) | null;
    remove(): void;
  }

  function stubDom(): { scripts: FakeScript[]; win: Record<string, unknown> } {
    const scripts: FakeScript[] = [];
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      querySelector: (selector: string) =>
        scripts.find((script) => selector.includes(script.src)) ?? null,
      createElement: () => {
        const element: FakeScript = {
          src: "",
          async: false,
          onerror: null,
          remove() {
            const at = scripts.indexOf(element);
            if (at >= 0) scripts.splice(at, 1);
          },
        };
        return element;
      },
      head: {
        appendChild: (element: FakeScript) => {
          scripts.push(element);
        },
      },
    });
    return { scripts, win };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refuses outright when there is no document to load into", async () => {
    const { loadIframeApi } = await import("./player");
    await expect(loadIframeApi()).rejects.toThrow(/no document/);
  });

  it("injects the tag and resolves when YouTube calls back", async () => {
    const { scripts, win } = stubDom();
    const { loadIframeApi } = await import("./player");
    const pending = loadIframeApi();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe("https://www.youtube.com/iframe_api");

    const namespace = { Player: function Player() {} };
    win.YT = namespace;
    (win.onYouTubeIframeAPIReady as () => void)();
    await expect(pending).resolves.toBe(namespace);
  });

  /**
   * The single global is the trap here.
   *
   * `onYouTubeIframeAPIReady` is one name on `window`, so anything else on the
   * page that wants the same API and assigns it last leaves whoever assigned
   * first waiting forever.
   */
  it("chains whatever was already listening instead of overwriting it", async () => {
    const { win } = stubDom();
    const previous = vi.fn();
    win.onYouTubeIframeAPIReady = previous;
    const { loadIframeApi } = await import("./player");
    const pending = loadIframeApi();
    win.YT = { Player: function Player() {} };
    (win.onYouTubeIframeAPIReady as () => void)();
    await pending;
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it("drops the failed tag and the memo, so a retry starts clean", async () => {
    const { scripts } = stubDom();
    const { loadIframeApi } = await import("./player");
    const pending = loadIframeApi();
    scripts[0].onerror?.();
    await expect(pending).rejects.toThrow(/failed to load/);
    expect(scripts).toHaveLength(0);

    // The retry the failure card offers has to be able to try again, which a
    // cached rejected promise would make impossible.
    void loadIframeApi().catch(() => {});
    expect(scripts).toHaveLength(1);
  });

  /**
   * The blocked-but-silent case, which `onerror` alone does not catch.
   *
   * A blocker answering the request with an empty 200 loads the tag happily
   * and never calls back. Without the deadline the panel spins forever, which
   * tells the viewer nothing at all.
   */
  it("gives up on a tag that loads but never calls back", async () => {
    vi.useFakeTimers();
    stubDom();
    const { loadIframeApi } = await import("./player");
    const pending = loadIframeApi(50);
    const assertion = expect(pending).rejects.toThrow(/did not load in time/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("does not add a second tag when the page already has one", async () => {
    const { scripts, win } = stubDom();
    scripts.push({
      src: "https://www.youtube.com/iframe_api",
      async: true,
      onerror: null,
      remove() {},
    });
    const { loadIframeApi } = await import("./player");
    const pending = loadIframeApi();
    expect(scripts).toHaveLength(1);
    win.YT = { Player: function Player() {} };
    (win.onYouTubeIframeAPIReady as () => void)();
    await expect(pending).resolves.toBeDefined();
  });
});

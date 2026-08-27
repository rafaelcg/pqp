import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWatchPartyPlayer,
  YOUTUBE_PLAYER_STATE,
  type CreateYouTubePlayer,
  type CreateYouTubePlayerOptions,
  type YouTubePlayerLike,
} from "./player";
import {
  applyPlayerEvent,
  applyRemoteState,
  createSession,
  type PlayerEvent,
  type WatchPartyEffects,
  type WatchPartySession,
} from "./state";
import type { WatchPartyState } from "@pqp/shared";

/**
 * THE ONE TEST THAT WOULD HAVE CAUGHT IT. A real `state` wired to a real
 * `player` over a fake handle, with nothing standing in for either.
 *
 * `state.ts` and `player.ts` were built, reviewed and tested in parallel. Both
 * suites were green. Three of five event names disagreed, both modules had
 * independently implemented scrub detection, and NEITHER MODULE HAD EVER BEEN
 * HANDED THE OTHER'S OUTPUT, so nothing anywhere failed. Reviewing each module
 * against its own contract cannot find that, because each module was correct
 * against its own contract. `docs/WATCH_PARTY.md` records the whole episode
 * under "Two green suites can still not be a feature", and the rule it leaves
 * behind is the reason this file exists: A SEAM THAT ONLY ONE SIDE HAS EVER
 * EXECUTED IS NOT A SEAM, IT IS TWO GUESSES THAT HAPPEN TO TYPECHECK
 * SEPARATELY.
 *
 * It costs almost nothing, which is the other half of the point. The player
 * takes its handle as an injected interface and `state` is pure, so both halves
 * run in the same `node` suite with no DOM, no network and no browser.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT FOR. It is not a second copy of
 * either module's suite; the reducer's arithmetic is pinned in `state.test.ts`
 * and the shell's behaviour in `player.test.ts`, both far more thoroughly than
 * here. Every test below fails ONLY for a reason that lives in the join: a
 * command one side emits and the other cannot execute, an event one side emits
 * and the other cannot fold, or a consumer that ends up with no input at all.
 * If a test here can go red without the two modules disagreeing, it belongs in
 * one of the other two files.
 */

const T0 = 1_700_000_000_000;
const VIDEO = "dQw4w9WgXcQ";
const ME = "peer-me";

const roomState = (over: Partial<WatchPartyState> = {}): WatchPartyState => ({
  videoId: VIDEO,
  status: "playing",
  positionMs: 10_000,
  // The sender's wall clock, deliberately nothing like the receiver's. Nothing
  // on either side of this seam may subtract it from a local `now`.
  atMs: T0 - 30_000,
  rev: 1,
  actorId: "peer-them",
  ...over,
});

/** The narrow slice of `YT.Player` the shell touches, and a record of every call. */
class FakeYouTubePlayer implements YouTubePlayerLike {
  calls: string[] = [];
  currentTimeSeconds = 0;
  /**
   * The state report a load owes back, wired up in `ready()`.
   *
   * A cue is asynchronous and the shell holds the rest of the batch until it
   * reports CUED, because the real player swallows anything said to it in
   * between. See `FakeYouTubePlayer.settle` in `player.test.ts` for the
   * measurement. Without this the seam would look joined while a real load
   * followed by a real play left one person staring at a still frame.
   */
  settle: ((code: number) => void) | null = null;

  private lands(code: number): void {
    queueMicrotask(() => this.settle?.(code));
  }

  loadVideoById(videoId: string, startSeconds?: number): void {
    this.calls.push(`loadVideoById:${videoId}:${startSeconds ?? ""}`);
    this.currentTimeSeconds = startSeconds ?? 0;
    this.lands(YOUTUBE_PLAYER_STATE.playing);
  }
  cueVideoById(videoId: string, startSeconds?: number): void {
    this.calls.push(`cueVideoById:${videoId}:${startSeconds ?? ""}`);
    // A cue lands where it was told to. A fake that stayed at zero would hand
    // the poll loop a ten second discontinuity nothing in the app caused, and
    // every test below would then pass or fail for that reason instead.
    this.currentTimeSeconds = startSeconds ?? 0;
    this.lands(YOUTUBE_PLAYER_STATE.cued);
  }
  playVideo(): void {
    this.calls.push("playVideo");
  }
  pauseVideo(): void {
    this.calls.push("pauseVideo");
  }
  seekTo(seconds: number, allowSeekAhead: boolean): void {
    this.calls.push(`seekTo:${seconds}:${allowSeekAhead}`);
    // The real player moves when told to. Without this the fake would report a
    // stale position for ever and the poll loop would see a permanent jump,
    // which is a fiction that would make the tests below pass for the wrong
    // reason.
    this.currentTimeSeconds = seconds;
  }
  getCurrentTime(): number {
    return this.currentTimeSeconds;
  }
  setPlaybackRate(rate: number): void {
    this.calls.push(`setPlaybackRate:${rate}`);
  }
  getAvailablePlaybackRates(): number[] {
    return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  }
  destroy(): void {
    this.calls.push("destroy");
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

/**
 * The whole client-side feature except the socket and the DOM.
 *
 * The player's events go straight into `applyPlayerEvent` and the resulting
 * commands go straight back into the player, which is exactly the loop the
 * container runs. Nothing translates, adapts or renames on the way: if a
 * translation layer were needed here, the two modules would not agree, and that
 * is the failure this file exists to make loud.
 */
function wire(options: { pollMs?: number } = {}) {
  const handle = new FakeYouTubePlayer();
  const clock = { ms: T0 };
  const events: PlayerEvent[] = [];
  const broadcasts: WatchPartyEffects["broadcast"][] = [];
  let session: WatchPartySession = createSession();
  let hooks: CreateYouTubePlayerOptions | null = null;
  let settle: ((player: YouTubePlayerLike) => void) | null = null;

  const createPlayer: CreateYouTubePlayer = (opts) => {
    hooks = opts;
    return new Promise<YouTubePlayerLike>((resolve) => {
      settle = resolve;
    });
  };

  const player = createWatchPartyPlayer({
    host: {} as HTMLElement,
    videoId: null,
    createPlayer,
    now: () => clock.ms,
    positionPollMs: options.pollMs ?? 250,
    onEvent: (event) => {
      events.push(event);
      const effects = applyPlayerEvent(session, event, ME, clock.ms);
      session = effects.session;
      broadcasts.push(effects.broadcast);
      // Straight back to the player, unexamined. This is the closing half of
      // the loop and the half nothing had ever run.
      player.executeAll(effects.commands);
    },
  });

  return {
    player,
    handle,
    events,
    broadcasts,
    get session() {
      return session;
    },
    hooks(): CreateYouTubePlayerOptions {
      if (!hooks) throw new Error("the player was never constructed");
      return hooks;
    },
    async ready(): Promise<void> {
      handle.settle = (code) => hooks?.onStateChange(code);
      settle?.(handle);
      await flush();
    },
    /** Let a cue reach CUED, which is what releases the commands behind it. */
    cueLands: flush,
    /** A frame from the room, folded in and acted on exactly as the app does. */
    fromRoom(state: WatchPartyState | null): void {
      const result = applyRemoteState(session, state, clock.ms);
      session = result.session;
      player.executeAll(result.commands);
    },
    /**
     * Advance the clock, the player's position and the poll timer together.
     *
     * `positionMs` defaults to `ms`, which is a player keeping perfect time.
     * Passing something else is how this file expresses the two things worth
     * expressing: 0 for a player falling behind or sitting paused, and a large
     * number for a hand on the scrubber.
     */
    advance(ms: number, positionMs: number = ms): void {
      clock.ms += ms;
      handle.currentTimeSeconds += positionMs / 1000;
      vi.advanceTimersByTime(ms);
    },
    clock,
  };
}

describe("the seam between state and player", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries out the commands adopting a remote state produces", async () => {
    /**
     * The forward direction, end to end. `state` decides a load and a play are
     * needed; the player has to be able to execute both without anything in
     * between renaming them. A command `state` emits and the player's `run`
     * has no arm for would land here and nowhere else: the switch is
     * exhaustive over the union, so a mismatch is a silent no-op rather than a
     * compile error.
     */
    const w = wire();
    await w.ready();
    w.fromRoom(roomState({ status: "playing", positionMs: 10_000 }));

    // The play is held until the cue reports CUED. It has to be: a `playVideo`
    // in the same tick as the `cueVideoById` is dropped by the real player,
    // and `load` then `play` is what every party start and every join emits.
    expect(w.handle.calls).toContain("cueVideoById:dQw4w9WgXcQ:10");
    await w.cueLands();
    expect(w.handle.calls).toContain("playVideo");
  });

  it("folds every event the player actually emits", async () => {
    /**
     * The reverse direction, and the one the original defect lived in. THREE OF
     * FIVE NAMES DISAGREED and nothing noticed, because no test ever handed a
     * real player event to the real reducer.
     *
     * This drives the player through a whole ordinary session and asserts that
     * every event it produced was one `applyPlayerEvent` has an arm for.
     * `applyPlayerEvent` returns a session for every arm of the union, so an
     * event kind it does not handle is a TypeScript error at the switch AND an
     * `undefined` here, which is what makes this assertion bite rather than
     * merely restate the type.
     */
    const w = wire({ pollMs: 100 });
    await w.ready();
    w.fromRoom(roomState({ status: "playing", positionMs: 10_000 }));
    w.hooks().onStateChange(YOUTUBE_PLAYER_STATE.buffering);
    w.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    w.hooks().onPlaybackRateChange(1.05);
    w.advance(100);
    w.hooks().onStateChange(YOUTUBE_PLAYER_STATE.paused);
    w.hooks().onError(150);

    const kinds = [...new Set(w.events.map((event) => event.kind))].sort();
    expect(kinds).toEqual(["failed", "phase", "position", "rate", "ready"]);
    for (const event of w.events) {
      expect(
        applyPlayerEvent(createSession(), event, ME, T0).session,
      ).toBeDefined();
    }
  });

  it("feeds the drift ladder on every poll, not only when something jumps", async () => {
    /**
     * THE STARVATION CASE, and the reason the position event carries its
     * discontinuity as a field rather than being a separate event.
     *
     * The ladder corrects drift from a continuous stream of positions. Make the
     * player emit only on a discontinuity and the ladder receives nothing at
     * all, for ever, and the room simply never converges: no error, no failing
     * assertion anywhere else, just a feature that quietly does not work. That
     * is the same shape as the bug this seam was built to close, pointing the
     * other way.
     *
     * So: put the local player half a second behind the room, which is the
     * middle rung of the ladder, and require that a rate nudge comes back out.
     * The only route from that drift to that command runs through a position
     * event the player was under no obligation to send.
     */
    const w = wire({ pollMs: 100 });
    await w.ready();
    w.fromRoom(roomState({ status: "playing", positionMs: 10_000 }));
    w.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    // Past the suppression window the load armed, keeping perfect time, so
    // nothing below can be attributed to the adoption.
    w.advance(1_200);
    // Half a second of wall clock with the video not moving: the local player
    // is now 500ms behind the room, which is the ladder's middle rung. Under
    // the player's own jump threshold, so it is drift and not a scrub, which is
    // exactly the distinction that has to survive the seam.
    w.advance(500, 0);

    expect(w.handle.calls).toContain("setPlaybackRate:1.05");
  });

  it("turns a hand on the scrubber into a write to the room", async () => {
    /**
     * THE DEFECT ITSELF, in one test.
     *
     * `player` polled the position and reported a discontinuity. `state` ran
     * its own detector over an event `player` never emitted. So `state`'s
     * detector received no input at all while `player`'s findings had nowhere
     * to go, and a person dragging YouTube's own scrubber moved nobody else's
     * video. Both suites stayed green throughout, each testing its own half
     * against its own vocabulary.
     *
     * Nothing below reaches into either module: a fake handle's position moves,
     * the way it does when a person drags the scrubber, and the room has to
     * hear about it.
     */
    const w = wire({ pollMs: 100 });
    await w.ready();
    w.fromRoom(roomState({ status: "playing", positionMs: 10_000 }));
    w.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    w.advance(1_200);

    // The scrubber, dragged five minutes forward. The IFrame API says nothing
    // about it, which is why the poll loop is the only witness.
    w.advance(100, 300_000);

    const written = w.broadcasts.filter((one) => one !== null);
    expect(written).not.toHaveLength(0);
    const last = written[written.length - 1];
    expect(last?.state?.positionMs).toBeGreaterThan(299_000);
    // A local action takes control of the room rather than merely reporting.
    expect(last?.state?.actorId).toBe(ME);
    expect(last?.state?.rev).toBeGreaterThan(1);
  });

  it("does not rebroadcast a remote pause it carried out itself", async () => {
    /**
     * ECHO SUPPRESSION ACROSS THE REAL SEAM, which is the only place it can
     * actually be observed. Both modules are honest on their own: the player
     * reports a phase change it caused exactly as loudly as one a person
     * caused, because telling them apart is not its job, and `state` holds the
     * window and the adopted state that make the distinction possible. Whether
     * the two together stay quiet is a property of neither.
     *
     * `docs/WATCH_PARTY.md` is specific about the assertion: ZERO broadcasts,
     * not one that happens to be identical. A single echo is enough for two
     * peers to answer each other until somebody closes the tab.
     */
    const w = wire({ pollMs: 100 });
    await w.ready();
    w.fromRoom(roomState({ status: "playing", positionMs: 10_000 }));
    w.hooks().onStateChange(YOUTUBE_PLAYER_STATE.playing);
    w.advance(1_200);

    // Somebody else pauses. We adopt it, command the player, and the player
    // does what a real one does: fires the same events a person's pause would.
    w.fromRoom(roomState({ status: "paused", positionMs: 11_200, rev: 2 }));
    const before = w.broadcasts.filter((one) => one !== null).length;
    w.hooks().onStateChange(YOUTUBE_PLAYER_STATE.paused);
    // Paused, so the position does not move. It must not: a paused player whose
    // position moves is the scrub case, and it would be heard.
    w.advance(100, 0);
    w.advance(100, 0);

    expect(w.broadcasts.filter((one) => one !== null).length).toBe(before);
  });
});

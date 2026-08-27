import { describe, expect, it } from "vitest";
import type { WatchPartyState } from "@pqp/shared";
import {
  applyLocalAction,
  applyLocalTeardown,
  applyPlayerEvent,
  applyRemoteMessage,
  applyRemoteState,
  createSession,
  currentState,
  DEFAULT_LADDER,
  decodeWatchPartyMessage,
  driftCommands,
  driftMs,
  encodeSetWatchParty,
  expectedPositionMs,
  nextResendAt,
  parseTimestampSeconds,
  parseYouTubeUrl,
  remoteStateWins,
  resendUnconfirmed,
  seekTargetMs,
  SEEK_ONLY_LADDER,
  setRateControl,
  snapPlaybackRate,
  type AdoptedState,
  type PlayerCommand,
  type PlayerEvent,
  type PlayerFailure,
  type WatchPartySession,
} from "./state";

/**
 * The rules two peers have to agree on without asking each other.
 *
 * Every claim below is one a plausible looking edit can quietly reverse and
 * that nothing else in the stack would catch: a convergence bug looks like "it
 * worked on my machine", an echo bug looks like the video pausing itself
 * forever, and a clock bug looks like nothing at all to the person who caused
 * it. The player and the UI can be exercised against a fake. This cannot be
 * exercised against anything, so it is written down instead.
 *
 * Each test here is meant to go red when its mechanism is deleted. If one stays
 * green with the code removed it is pinning something the compiler already
 * owns, and `docs/WATCH_PARTY.md` explains at length why that is worse than
 * having no test at all.
 *
 * EVERY CONSTANT UNDER TEST IS SPELLED OUT AS A LITERAL AND NEVER IMPORTED.
 * Writing `T0 + SUPPRESSION_WINDOW_MS` pins nothing: change the constant and
 * the assertion moves with it, and the suite stays green while the window
 * silently becomes two and a half seconds. So the window is written as 1000,
 * the deadband as 150, the settle threshold as 100, the seek overshoot as 300
 * and the backoff as 500 doubling to 4000. Change one of those in `state.ts`
 * and something here has to go red, which is the entire point of the file.
 */

const T0 = 1_700_000_000_000;
const CHANNEL = "11111111-1111-1111-1111-111111111111";
const VIDEO = "dQw4w9WgXcQ";
const OTHER_VIDEO = "9bZkp7q19f0";
const ME = "peer-me";

const state = (over: Partial<WatchPartyState> = {}): WatchPartyState => ({
  videoId: VIDEO,
  status: "playing",
  positionMs: 10_000,
  // Deliberately not T0. Nothing in this module may read it, and a value that
  // is never the receiver's clock is how these tests notice if something does.
  atMs: T0 - 30_000,
  rev: 1,
  actorId: "peer-a",
  ...over,
});

const adopted = (
  over: Partial<WatchPartyState> = {},
  adoptedAt = T0,
): AdoptedState => ({ state: state(over), adoptedAt });

const event = (e: PlayerEvent) => e;

/**
 * A player that will not play. The mapping from a raw code onto a reason lives
 * with the player that produces the codes, so this file only ever builds the
 * fact that reaches the reducer.
 */
const failure = (code: number): PlayerFailure => ({
  reason: code === 153 ? "refererBlocked" : "notPlayable",
  code,
  videoId: VIDEO,
  environmental: code === 153,
  watchOnYouTubeUrl: `https://www.youtube.com/watch?v=${VIDEO}`,
});

/** A local write this peer is allowed to make. Null means it was refused. */
const mustWrite = (
  effects: ReturnType<typeof applyLocalAction>,
): NonNullable<ReturnType<typeof applyLocalAction>> => {
  if (effects === null) throw new Error("this peer was refused the write");
  return effects;
};

interface Beat {
  at: number;
  event: PlayerEvent;
}

/** Feed a real event sequence through a session and keep everything it said. */
function feed(
  session: WatchPartySession,
  beats: Beat[],
): {
  session: WatchPartySession;
  broadcasts: (ReturnType<typeof applyPlayerEvent>["broadcast"])[];
  commands: PlayerCommand[][];
} {
  let current = session;
  const broadcasts: (ReturnType<typeof applyPlayerEvent>["broadcast"])[] = [];
  const commands: PlayerCommand[][] = [];
  for (const beat of beats) {
    const effects = applyPlayerEvent(current, beat.event, ME, beat.at);
    current = effects.session;
    broadcasts.push(effects.broadcast);
    commands.push(effects.commands);
  }
  return { session: current, broadcasts, commands };
}

/**
 * A peer watching VIDEO, its player loaded and playing, in step with the room
 * and past its suppression window. Built through the public path rather than by
 * hand, so the tests below start from a session the module itself produced.
 */
function watching(): { session: WatchPartySession; at: number } {
  const joined = applyRemoteState(
    createSession(),
    state({ status: "playing", positionMs: 10_000, rev: 1 }),
    T0,
  ).session;
  // Past the window, in step: the party expects 12_000 by now and so does the
  // player.
  const session = feed(joined, [
    { at: T0 + 200, event: { kind: "phase", phase: "playing", positionMs: 10_000 } },
    { at: T0 + 2_000, event: { kind: "position", positionMs: 12_000, jumpedFromMs: null } },
  ]).session;
  return { session, at: T0 + 2_000 };
}

/* -------------------------------------------------------------------------- */
/* Last writer wins                                                            */
/* -------------------------------------------------------------------------- */

describe("last writer wins", () => {
  it("takes the higher rev when it arrives", () => {
    const session = applyRemoteState(createSession(), state({ rev: 4 }), T0).session;
    const result = applyRemoteState(session, state({ rev: 5, positionMs: 99_000 }), T0);
    expect(result.applied).toBe(true);
    expect(currentState(result.session)?.rev).toBe(5);
  });

  it("keeps the higher rev when a lower one arrives", () => {
    const session = applyRemoteState(
      createSession(),
      state({ rev: 5, positionMs: 99_000 }),
      T0,
    ).session;
    const result = applyRemoteState(session, state({ rev: 4 }), T0 + 10);
    expect(result.applied).toBe(false);
    expect(currentState(result.session)?.positionMs).toBe(99_000);
  });

  it("takes any state at all when this peer is holding none", () => {
    const result = applyRemoteState(createSession(), state({ rev: 0 }), T0);
    expect(result.applied).toBe(true);
    expect(currentState(result.session)?.rev).toBe(0);
  });

  it("breaks an equal rev on the higher actorId, lexically", () => {
    expect(
      remoteStateWins(state({ rev: 3, actorId: "aaa" }), state({ rev: 3, actorId: "bbb" })),
    ).toBe(true);
    expect(
      remoteStateWins(state({ rev: 3, actorId: "bbb" }), state({ rev: 3, actorId: "aaa" })),
    ).toBe(false);
  });

  it("orders the tie by UTF-16 code unit and not the way a locale would", () => {
    /**
     * The pair that separates the two rules, and the reason the comparison must
     * stay a bare `>`. "a" sits above "B" in UTF-16 and below it in the
     * collation `localeCompare` reaches for, so the friendlier looking function
     * picks the other winner. An ordering that is not identical on every machine
     * is not a tie break, it is a split brain, and it splits along whatever
     * locales the room happens to be running.
     */
    expect("a".localeCompare("B")).toBeLessThan(0);
    expect("a" > "B").toBe(true);

    expect(
      remoteStateWins(state({ rev: 3, actorId: "B" }), state({ rev: 3, actorId: "a" })),
    ).toBe(true);
    expect(
      remoteStateWins(state({ rev: 3, actorId: "a" }), state({ rev: 3, actorId: "B" })),
    ).toBe(false);
  });

  it("treats the same write arriving twice as no change at all", () => {
    // Our own echo, and every resend of it, comes back through this path.
    const mine = state({ rev: 3, actorId: ME });
    expect(remoteStateWins(mine, mine)).toBe(false);
  });

  it("settles after one application however many times a state repeats", () => {
    const incoming = state({ rev: 3 });
    let session = createSession();
    const applications: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = applyRemoteState(session, incoming, T0 + i * 100);
      applications.push(result.applied);
      session = result.session;
    }
    expect(applications).toEqual([true, false, false, false, false]);
  });
});

describe("simultaneous conflicting writes", () => {
  /**
   * Two people hit pause at the same instant, each on rev 4, neither having
   * heard the other. Both orderings are asserted because a rule that converges
   * only when the messages happen to arrive in one order is not a rule, it is
   * luck, and the half of the room that got the other order is gone.
   */
  const fromA = state({ rev: 4, actorId: "peer-a", status: "paused", positionMs: 1_000 });
  const fromB = state({ rev: 4, actorId: "peer-b", status: "playing", positionMs: 2_000 });

  it("resolves identically on both of the peers that clashed", () => {
    const onA = applyRemoteState(
      applyRemoteState(createSession(), fromA, T0).session,
      fromB,
      T0 + 5,
    );
    const onB = applyRemoteState(
      applyRemoteState(createSession(), fromB, T0).session,
      fromA,
      T0 + 5,
    );
    expect(currentState(onA.session)).toEqual(currentState(onB.session));
    expect(currentState(onA.session)).toEqual(fromB);
  });

  it("resolves identically whichever order a third peer hears them in", () => {
    const forwards = applyRemoteState(
      applyRemoteState(createSession(), fromA, T0).session,
      fromB,
      T0 + 40,
    ).session;
    const backwards = applyRemoteState(
      applyRemoteState(createSession(), fromB, T0).session,
      fromA,
      T0 + 40,
    ).session;
    expect(currentState(forwards)).toEqual(currentState(backwards));
    expect(currentState(forwards)).toEqual(fromB);
  });

  it("leaves both peers counting from the same rev afterwards", () => {
    const onA = applyRemoteState(
      applyRemoteState(createSession(), fromA, T0).session,
      fromB,
      T0 + 5,
    ).session;
    const onB = applyRemoteState(
      applyRemoteState(createSession(), fromB, T0).session,
      fromA,
      T0 + 5,
    ).session;
    expect(onA.maxSeenRev).toBe(4);
    expect(onB.maxSeenRev).toBe(4);
  });
});

describe("a local action outranks everything this peer has heard", () => {
  it("numbers itself one above the highest rev seen", () => {
    const session = applyRemoteState(createSession(), state({ rev: 7 }), T0).session;
    const result = mustWrite(
      applyLocalAction(session, { status: "paused", positionMs: 4_200 }, ME, T0 + 1_000),
    );
    expect(result.broadcast?.state?.rev).toBe(8);
    expect(result.session.maxSeenRev).toBe(8);
  });

  it("counts from the highest rev seen, not from the state it is showing", () => {
    // A teardown clears the state while the conversation that reached rev 9
    // still happened. Restarting at 1 here would lose every argument against a
    // peer that kept counting.
    const heard = applyRemoteState(createSession(), state({ rev: 9 }), T0).session;
    const torn = applyRemoteState(heard, null, T0 + 10).session;
    expect(currentState(torn)).toBeNull();
    expect(torn.maxSeenRev).toBe(9);

    const restarted = mustWrite(
      applyLocalAction(torn, { videoId: VIDEO, status: "playing", positionMs: 0 }, ME, T0 + 20),
    );
    expect(restarted.broadcast?.state?.rev).toBe(10);
  });

  it("keeps counting through a teardown this peer asked for itself", () => {
    const session = applyRemoteState(createSession(), state({ rev: 9 }), T0).session;
    const closed = applyLocalTeardown(session, T0 + 100);
    expect(closed.broadcast).toEqual({ type: "set-watch-party", state: null });
    expect(currentState(closed.session)).toBeNull();
    expect(closed.session.maxSeenRev).toBe(9);
  });

  it("records a rev it heard and rejected", () => {
    // The losing state is still evidence of how far the conversation got.
    // Forgetting it makes two peers ping-pong at the same number indefinitely.
    const session = applyRemoteState(createSession(), state({ rev: 6, actorId: "zzz" }), T0)
      .session;
    const after = applyRemoteState(session, state({ rev: 6, actorId: "aaa" }), T0 + 5);
    expect(after.applied).toBe(false);
    expect(after.session.maxSeenRev).toBe(6);
  });

  it("keeps the loaded video when the intent does not mention one", () => {
    const session = applyRemoteState(createSession(), state(), T0).session;
    const result = mustWrite(
      applyLocalAction(session, { status: "paused", positionMs: 500 }, ME, T0 + 1),
    );
    expect(result.broadcast?.state?.videoId).toBe(VIDEO);
  });

  it("clears the video when the intent says null, without ending the party", () => {
    const session = applyRemoteState(createSession(), state(), T0).session;
    const result = mustWrite(
      applyLocalAction(session, { videoId: null, status: "paused", positionMs: 0 }, ME, T0 + 1),
    );
    expect(result.broadcast?.state).not.toBeNull();
    expect(result.broadcast?.state?.videoId).toBeNull();
  });

  it("rounds the fractional position the player reports", () => {
    // `getCurrentTime()` returns float seconds and the wire takes an integer.
    // Rounding at the caller instead means a player wrapper can forget and have
    // its frames rejected by the server's parse.
    const result = mustWrite(
      applyLocalAction(
        createSession(),
        { videoId: VIDEO, status: "playing", positionMs: 4_200.7 },
        ME,
        T0 + 0.4,
      ),
    );
    expect(result.broadcast?.state?.positionMs).toBe(4_201);
    expect(result.broadcast?.state?.atMs).toBe(T0);
  });

  it("adopts its own write on the same clock a remote one uses", () => {
    const result = mustWrite(
      applyLocalAction(
        createSession(),
        { videoId: VIDEO, status: "playing", positionMs: 10_000 },
        ME,
        T0,
      ),
    );
    expect(result.session.adopted?.adoptedAt).toBe(T0);
    expect(expectedPositionMs(result.session.adopted!, T0 + 2_000)).toBe(12_000);
  });

  it("refuses to send a state the wire would reject", () => {
    expect(() => encodeSetWatchParty(state({ actorId: "" }))).toThrow(/actorId/);
  });
});

/* -------------------------------------------------------------------------- */
/* Frames off the wire                                                         */
/* -------------------------------------------------------------------------- */

describe("frames off the wire", () => {
  it("drops a malformed frame without touching the session", () => {
    const session = applyRemoteState(createSession(), state({ rev: 2 }), T0).session;
    for (const raw of [
      null,
      "watch-party",
      { type: "watch-party" },
      { type: "watch-party", channelId: "not-a-uuid", state: state() },
      { type: "watch-party", channelId: CHANNEL, state: { ...state(), rev: -1 } },
      { type: "watch-party", channelId: CHANNEL, state: { ...state(), status: "buffering" } },
      { type: "watch-party", channelId: CHANNEL, state: { ...state(), actorId: "" } },
      { type: "set-watch-party", state: state() },
    ]) {
      const result = applyRemoteMessage(session, raw, T0 + 100, CHANNEL);
      expect(result.applied, JSON.stringify(raw)).toBe(false);
      expect(result.session).toBe(session);
    }
  });

  it("ignores a frame for a different channel", () => {
    const result = applyRemoteMessage(
      createSession(),
      {
        type: "watch-party",
        channelId: "22222222-2222-2222-2222-222222222222",
        state: state({ rev: 9 }),
      },
      T0,
      CHANNEL,
    );
    expect(result.applied).toBe(false);
    expect(result.session.maxSeenRev).toBe(0);
  });

  it("treats a null state as the party being torn down", () => {
    const session = applyRemoteState(createSession(), state({ rev: 3 }), T0).session;
    const result = applyRemoteMessage(
      session,
      { type: "watch-party", channelId: CHANNEL, state: null },
      T0 + 10,
      CHANNEL,
    );
    expect(result.applied).toBe(true);
    expect(currentState(result.session)).toBeNull();
    expect(result.session.maxSeenRev).toBe(3);
  });

  it("says nothing changed when a teardown arrives on an empty session", () => {
    expect(applyRemoteState(createSession(), null, T0).applied).toBe(false);
  });

  it("round trips a frame it built itself", () => {
    const frame = { type: "watch-party", channelId: CHANNEL, state: state() };
    expect(decodeWatchPartyMessage(frame)).toEqual(frame);
  });
});

/* -------------------------------------------------------------------------- */
/* What the player is told                                                     */
/* -------------------------------------------------------------------------- */

describe("bringing the local player in line with an adopted state", () => {
  it("loads and starts a video this peer has never seen", () => {
    const result = applyRemoteState(
      createSession(),
      state({ status: "playing", positionMs: 10_000 }),
      T0,
    );
    expect(result.commands).toEqual([
      { kind: "load", videoId: VIDEO, positionMs: 10_000 },
      { kind: "play" },
    ]);
  });

  it("loads a paused party without starting it", () => {
    const result = applyRemoteState(
      createSession(),
      state({ status: "paused", positionMs: 10_000 }),
      T0,
    );
    expect(result.commands).toEqual([
      { kind: "load", videoId: VIDEO, positionMs: 10_000 },
      { kind: "pause" },
    ]);
  });

  it("leaves an ended party where it ended rather than seeking it back", () => {
    // Satisfying an arithmetic check here would restart a video nobody asked to
    // restart.
    const start = watching();
    const ended = applyRemoteState(
      start.session,
      state({ status: "ended", positionMs: 200_000, rev: 2 }),
      start.at + 100,
    );
    expect(ended.applied).toBe(true);
    expect(ended.commands).toEqual([]);
  });

  it("seeks the local player into line at 150ms out and leaves it alone at 149", () => {
    /**
     * Adoption is not drift. Somebody deliberately moved the party, so the
     * threshold here is the 150ms tolerance and not the full second the ladder
     * waits for: the jump has already happened for everybody else and matching
     * it late is worse than matching it now. This player is predicted at 13_000.
     */
    const start = watching();
    const adopting = (positionMs: number) =>
      applyRemoteState(
        start.session,
        state({ status: "paused", positionMs, rev: 2 }),
        T0 + 3_000,
      ).commands;

    expect(adopting(13_149)).toEqual([{ kind: "pause" }]);
    expect(adopting(13_150)).toEqual([
      { kind: "seek", positionMs: 13_150 },
      { kind: "pause" },
    ]);
  });

  it("does not widen that threshold with the ladder on a seek-only peer", () => {
    // The tolerance is its own constant for a reason. Read it off the ladder
    // instead and a peer that fell back to seek-only correction, whose deadband
    // is a full second, silently stops matching the room when somebody moves it.
    const degraded = setRateControl(watching().session, false);
    expect(
      applyRemoteState(
        degraded,
        state({ status: "paused", positionMs: 13_150, rev: 2 }),
        T0 + 3_000,
      ).commands,
    ).toEqual([{ kind: "seek", positionMs: 13_150 }, { kind: "pause" }]);
  });

  it("answers a remote state with commands and never with a message", () => {
    // Not the type-level claim an earlier suite made, which the return type
    // already guaranteed and which therefore could not fail. This is the runtime
    // one: a state that wins, a state that loses and a teardown all leave the
    // player with work and the room with silence.
    const start = watching();
    const winner = applyRemoteState(
      start.session,
      state({ status: "playing", positionMs: 90_000, rev: 2 }),
      start.at + 100,
    );
    expect(winner.applied).toBe(true);
    expect(winner.commands.length).toBeGreaterThan(0);

    expect(applyRemoteState(start.session, state({ rev: 0 }), start.at + 200).commands).toEqual([]);
    expect(applyRemoteState(start.session, null, start.at + 300).commands).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The echo guard                                                              */
/* -------------------------------------------------------------------------- */

describe("the echo guard: the suppression window", () => {
  /**
   * The half that covers the transient. A programmatic seek fires BUFFERING and
   * then PLAYING before the seek lands, and `getCurrentTime()` still reads the
   * position the player is leaving, so the semantic check on its own compares
   * playing@13s against an adopted playing@60s and broadcasts. That is the
   * oscillation. Delete `suppressUntil` and this goes red.
   */
  it("says nothing while the player reports the position a remote seek is leaving", () => {
    const start = watching();
    const seeked = applyRemoteState(
      start.session,
      state({ status: "playing", positionMs: 60_000, rev: 2 }),
      T0 + 3_000,
    );
    expect(seeked.commands).toEqual([{ kind: "seek", positionMs: 60_300 }]);

    const played = feed(seeked.session, [
      { at: T0 + 3_050, event: { kind: "phase", phase: "buffering", positionMs: 13_000 } },
      { at: T0 + 3_200, event: { kind: "phase", phase: "playing", positionMs: 13_000 } },
      { at: T0 + 3_400, event: { kind: "position", positionMs: 60_400, jumpedFromMs: null } },
    ]);
    expect(played.broadcasts).toEqual([null, null, null]);
  });

  it("expires on the clock rather than on the event it was waiting for", () => {
    /**
     * A window cleared by "the event we expect to see" would stick here forever:
     * telling an already paused player to pause emits nothing, so the event
     * never comes. The next genuine action would then be swallowed, and every
     * one after it, silently and for the rest of the session. The proof that it
     * is a deadline is that the window closes with no event arriving at all.
     */
    const start = watching();
    // 13_000 is exactly where this player is predicted to be, so the only
    // command is the pause and no seek muddies the sequence.
    const paused = applyRemoteState(
      start.session,
      state({ status: "paused", positionMs: 13_000, rev: 2 }),
      T0 + 3_000,
    );
    expect(paused.commands).toEqual([{ kind: "pause" }]);

    const acted = applyPlayerEvent(
      paused.session,
      event({ kind: "phase", phase: "playing", positionMs: 13_000 }),
      ME,
      T0 + 4_000,
    );
    expect(acted.broadcast?.state?.status).toBe("playing");
    expect(acted.broadcast?.state?.rev).toBe(3);
  });

  it("keeps the window shut for one second and not a moment longer", () => {
    /**
     * The boundary, written out rather than derived, because deriving it from
     * the constant is how the window quietly became two and a half seconds once
     * before. The session and the event are identical across the two calls and
     * only the clock moves, so nothing else can be what changed the answer.
     */
    const start = watching();
    const paused = applyRemoteState(
      start.session,
      state({ status: "paused", positionMs: 13_000, rev: 2 }),
      T0 + 3_000,
    ).session;
    const person = event({ kind: "phase", phase: "playing", positionMs: 13_000 });

    expect(applyPlayerEvent(paused, person, ME, T0 + 3_999).broadcast).toBeNull();
    expect(applyPlayerEvent(paused, person, ME, T0 + 4_000).broadcast).not.toBeNull();
  });
});

describe("the echo guard: never rebroadcast the room's own decision", () => {
  /**
   * The canonical one from `docs/WATCH_PARTY.md`, and the reason that document
   * says "not one broadcast that happens to be identical, zero". Somebody else
   * pressed pause. The whole event sequence a real player produces goes through,
   * spanning the window and running well past it, and this peer says nothing at
   * any point in it. Two peers that answer each other here climb the rev until
   * somebody closes the tab.
   */
  const roomPaused = (): WatchPartySession =>
    applyRemoteState(
      watching().session,
      state({ status: "paused", positionMs: 30_000, rev: 2 }),
      T0 + 3_000,
    ).session;

  it("says nothing at all while the player carries out a pause somebody else pressed", () => {
    const played = feed(roomPaused(), [
      // The seek and the pause are both in flight. BUFFERING and PAUSED fire
      // before the seek lands, so both report the position being left behind.
      { at: T0 + 3_050, event: { kind: "phase", phase: "buffering", positionMs: 13_000 } },
      { at: T0 + 3_150, event: { kind: "phase", phase: "paused", positionMs: 13_000 } },
      { at: T0 + 3_400, event: { kind: "position", positionMs: 30_000, jumpedFromMs: null } },
      // Past the window. From here only the semantic half is holding it, which
      // is the case a player slow to buffer really does produce.
      { at: T0 + 4_600, event: { kind: "phase", phase: "paused", positionMs: 30_000 } },
      { at: T0 + 4_850, event: { kind: "position", positionMs: 30_000, jumpedFromMs: null } },
      { at: T0 + 5_100, event: { kind: "position", positionMs: 30_000, jumpedFromMs: null } },
      { at: T0 + 6_000, event: { kind: "phase", phase: "paused", positionMs: 30_000 } },
    ]);
    expect(played.broadcasts).toEqual([null, null, null, null, null, null, null]);
  });

  it("hears the person who presses play once the room's pause has landed", () => {
    /**
     * The other side of the same coin, and the failure nobody notices until an
     * evening's worth of pauses have gone missing. A guard that swallows
     * everything is not a guard, it is a mute button.
     */
    const settled = feed(roomPaused(), [
      { at: T0 + 3_150, event: { kind: "phase", phase: "paused", positionMs: 13_000 } },
      { at: T0 + 4_600, event: { kind: "phase", phase: "paused", positionMs: 30_000 } },
    ]).session;

    const person = applyPlayerEvent(
      settled,
      event({ kind: "phase", phase: "playing", positionMs: 30_000 }),
      ME,
      T0 + 7_000,
    );
    expect(person.broadcast?.state).toMatchObject({
      status: "playing",
      positionMs: 30_000,
      rev: 3,
      actorId: ME,
    });
  });

  it("stays quiet through a whole party's worth of ticks that say nothing new", () => {
    const start = watching();
    const ticks: Beat[] = [];
    for (let i = 1; i <= 60; i += 1) {
      ticks.push({
        at: start.at + i * 250,
        event: { kind: "position", positionMs: 12_000 + i * 250, jumpedFromMs: null },
      });
    }
    expect(feed(start.session, ticks).broadcasts.every((one) => one === null)).toBe(true);
  });

  it("never announces a phase the wire has no word for", () => {
    /**
     * Unstarted, buffering and cued are on the way to somewhere rather than
     * somewhere. Buffering would have every peer announce every stall, and
     * `cued` is what a load leaves behind, so reading that one as a real phase
     * would have every single join broadcast its own arrival at position zero.
     * The window is long closed here and the reported position is nothing like
     * the adopted one, so this guard is the only thing holding any of them.
     */
    const start = watching();
    for (const phase of ["buffering", "unstarted", "cued"] as const) {
      const effects = applyPlayerEvent(
        start.session,
        event({ kind: "phase", phase, positionMs: 0 }),
        ME,
        start.at + 5_000,
      );
      expect(effects.broadcast, phase).toBeNull();
    }
  });

  it("says nothing when a late event only repeats the state we adopted", () => {
    // The half that does not expire, on its own. Delete `isChangeFromAdopted`
    // and this goes red while the window test stays green, which is why both
    // halves are here.
    const start = watching();
    const paused = applyRemoteState(
      start.session,
      state({ status: "paused", positionMs: 13_000, rev: 2 }),
      T0 + 3_000,
    ).session;
    const late = applyPlayerEvent(
      paused,
      event({ kind: "phase", phase: "paused", positionMs: 13_000 }),
      ME,
      T0 + 5_000,
    );
    expect(late.broadcast).toBeNull();
  });

  it("ignores the position a phase event carries, because it is unreliable by construction", () => {
    /**
     * BUFFERING and PLAYING both fire before a seek lands, so the number a phase
     * event carries is the position being left rather than the one being gone
     * to. It was never the right witness for a scrub, and treating it as one
     * cost a room reset on every slow join. A genuine scrub reaches `onPosition`
     * instead, with a position that has actually landed.
     *
     * Note the direction: this makes the guard suppress more and never less, so
     * it cannot reopen the oscillation the guard exists to close.
     */
    const start = watching();
    const paused = applyRemoteState(
      start.session,
      state({ status: "paused", positionMs: 13_000, rev: 2 }),
      T0 + 3_000,
    ).session;
    const reporting = (positionMs: number) =>
      applyPlayerEvent(
        paused,
        event({ kind: "phase", phase: "paused", positionMs }),
        ME,
        T0 + 5_000,
      ).broadcast;

    for (const positionMs of [0, 12_850, 13_000, 13_150, 200_000]) {
      expect(reporting(positionMs), String(positionMs)).toBeNull();
    }
  });

  it("still hears the phase itself change, whatever position rides along with it", () => {
    // The other direction, so the test above cannot be satisfied by a guard that
    // simply stopped listening to phase events.
    const start = watching();
    const paused = applyRemoteState(
      start.session,
      state({ status: "paused", positionMs: 13_000, rev: 2 }),
      T0 + 3_000,
    ).session;
    const resumed = applyPlayerEvent(
      paused,
      event({ kind: "phase", phase: "playing", positionMs: 0 }),
      ME,
      T0 + 5_000,
    );
    expect(resumed.broadcast?.state).toMatchObject({ status: "playing", rev: 3, actorId: ME });
  });
});

/* -------------------------------------------------------------------------- */
/* Scrubs                                                                      */
/* -------------------------------------------------------------------------- */

describe("whose jump it was", () => {
  /**
   * The player sees a discontinuity and reports it without an opinion, because
   * a hand on the scrubber, a seek this peer issued a moment ago and a long
   * rebuffer are indistinguishable from where it sits. Attributing it is this
   * module's job, and the suppression window is the only thing it has to do it
   * with. Getting it wrong in one direction rebroadcasts the room's own seek
   * back at the room; getting it wrong in the other loses a person's scrub.
   */
  it("announces a jump nothing of ours can account for", () => {
    const start = watching();
    const scrubbed = applyPlayerEvent(
      start.session,
      event({ kind: "position", positionMs: 90_000, jumpedFromMs: 12_250 }),
      ME,
      start.at + 250,
    );
    expect(scrubbed.broadcast?.state).toMatchObject({
      videoId: VIDEO,
      status: "playing",
      positionMs: 90_000,
      rev: 2,
      actorId: ME,
    });
  });

  it("says nothing about the jump its own corrective seek caused", () => {
    const start = watching();
    const jumped = applyRemoteState(
      start.session,
      state({ status: "playing", positionMs: 100_000, rev: 2 }),
      T0 + 3_000,
    );
    expect(jumped.commands).toEqual([{ kind: "seek", positionMs: 100_300 }]);

    const reported = applyPlayerEvent(
      jumped.session,
      event({ kind: "position", positionMs: 100_300, jumpedFromMs: 13_000 }),
      ME,
      T0 + 3_200,
    );
    expect(reported.broadcast).toBeNull();
  });

  it("reads a continuous position as drift and corrects it without a word", () => {
    // The player says it arrived where its own clock predicted, so nobody
    // touched anything and this peer is simply behind. Announcing that lag
    // would drag the whole room back to it.
    const start = watching();
    const behind = applyPlayerEvent(
      start.session,
      event({ kind: "position", positionMs: 10_350, jumpedFromMs: null }),
      ME,
      start.at + 250,
    );
    expect(behind.broadcast).toBeNull();
    expect(behind.commands).toEqual([{ kind: "seek", positionMs: 12_550 }]);
  });

  it("feeds the drift ladder on every sample, jump or no jump", () => {
    // Both consumers read this one event. A position that also carries a jump
    // must still reach the ladder, or a peer that scrubs once stops being
    // corrected until the next discontinuity.
    const start = watching();
    const sampled = feed(start.session, [
      { at: start.at + 250, event: { kind: "position", positionMs: 12_600, jumpedFromMs: null } },
      { at: start.at + 500, event: { kind: "position", positionMs: 12_900, jumpedFromMs: null } },
    ]);
    expect(sampled.commands.at(-1)).toEqual([{ kind: "setRate", rate: 0.95 }]);
  });
});

/* -------------------------------------------------------------------------- */
/* Clocks                                                                      */
/* -------------------------------------------------------------------------- */

describe("one clock, and it is the receiver's", () => {
  it("measures elapsed from when the state arrived, not from the sender's atMs", () => {
    /**
     * The bug this rule replaced is invisible from the sending side and
     * permanent once it happens. A sender whose clock is 30 seconds slow puts
     * the expected position 30 seconds into everybody else's future, so every
     * receiver seeks forward and sits there, stably out of step, while the
     * sender's own party looks perfect. Three senders here, three wildly
     * different wall clocks, one arrival time, and it must be one answer.
     */
    const answers = [T0 - 30_000, T0, T0 + 30_000].map((atMs) =>
      expectedPositionMs(adopted({ positionMs: 10_000, atMs }, T0), T0 + 5_000),
    );
    expect(answers).toEqual([15_000, 15_000, 15_000]);
  });

  it("leaves a correctly placed player alone even when the sender's clock is wrong", () => {
    // The same rule where it is actually felt. This player sits exactly where
    // arrival-time arithmetic says it should. Subtract `atMs` instead and it
    // reads as thirty seconds out, and the room seeks it into the weeds.
    const joined = applyRemoteState(
      createSession(),
      state({ status: "playing", positionMs: 10_000, atMs: T0 - 30_000 }),
      T0,
    ).session;
    const settled = feed(joined, [
      { at: T0 + 500, event: { kind: "phase", phase: "playing", positionMs: 10_000 } },
      { at: T0 + 4_000, event: { kind: "position", positionMs: 14_000, jumpedFromMs: null } },
    ]);
    expect(settled.commands.at(-1)).toEqual([]);
    expect(settled.broadcasts).toEqual([null, null]);
  });

  it("does not advance a paused or ended position", () => {
    expect(expectedPositionMs(adopted({ status: "paused" }), T0 + 5_000)).toBe(10_000);
    expect(expectedPositionMs(adopted({ status: "ended" }), T0 + 5_000)).toBe(10_000);
  });

  it("never winds backwards when now predates the arrival", () => {
    expect(expectedPositionMs(adopted({ positionMs: 10_000 }, T0 + 800), T0)).toBe(10_000);
  });

  it("reports the local player as ahead with a positive drift", () => {
    expect(driftMs(adopted(), 10_400, T0)).toBe(400);
    expect(driftMs(adopted(), 9_600, T0)).toBe(-400);
  });
});

/* -------------------------------------------------------------------------- */
/* The drift ladder                                                            */
/* -------------------------------------------------------------------------- */

describe("the drift ladder", () => {
  const party = adopted({ positionMs: 10_000 }, T0);
  const NOW = T0 + 5_000; // the party expects 15_000
  const decide = (localPositionMs: number, playbackRate = 1) =>
    driftCommands({ adopted: party, localPositionMs, now: NOW, playbackRate });

  it("leaves a player alone under 150ms of drift", () => {
    expect(decide(15_000)).toEqual([]);
    expect(decide(15_149)).toEqual([]);
    expect(decide(14_851)).toEqual([]);
  });

  it("starts nudging at exactly 150ms", () => {
    expect(decide(15_150)).toEqual([{ kind: "setRate", rate: 0.95 }]);
    expect(decide(14_850)).toEqual([{ kind: "setRate", rate: 1.05 }]);
  });

  it("slows a player that is ahead and speeds up one that is behind", () => {
    expect(decide(15_500)).toEqual([{ kind: "setRate", rate: 0.95 }]);
    expect(decide(14_500)).toEqual([{ kind: "setRate", rate: 1.05 }]);
  });

  it("still nudges rather than seeks at exactly one second", () => {
    // A seek here costs a longer stall than the drift it corrects. 50ms of seek
    // was measured costing a 264ms stall, so there is no such thing as a cheap
    // small one, and that is what the middle rung exists to avoid.
    expect(decide(16_000)).toEqual([{ kind: "setRate", rate: 0.95 }]);
    expect(decide(14_000)).toEqual([{ kind: "setRate", rate: 1.05 }]);
  });

  it("seeks past one second, landing 300ms ahead of the party rather than on it", () => {
    // The stall lands you behind where you aimed, so aim past it. The number is
    // measured and belongs here as a number: derive it from the constant and a
    // change to the constant leaves this green.
    expect(expectedPositionMs(party, NOW)).toBe(15_000);
    expect(seekTargetMs(party, NOW)).toBe(15_300);
    expect(decide(16_001)).toEqual([{ kind: "seek", positionMs: 15_300 }]);
    expect(decide(13_999)).toEqual([{ kind: "seek", positionMs: 15_300 }]);
  });

  it("holds a running nudge down to exactly 100ms", () => {
    // Hysteresis. Letting go the instant the gap crosses back under 150ms leaves
    // the player on the edge, re-triggering, and the rate chatters audibly.
    expect(decide(15_120, 0.95)).toEqual([{ kind: "setRate", rate: 0.95 }]);
    expect(decide(15_100, 0.95)).toEqual([{ kind: "setRate", rate: 0.95 }]);
  });

  it("restores the rate to exactly 1 once the drift is under 100ms", () => {
    expect(decide(15_099, 0.95)).toEqual([{ kind: "setRate", rate: 1 }]);
    expect(decide(14_901, 1.05)).toEqual([{ kind: "setRate", rate: 1 }]);
  });

  it("does not start a nudge inside the deadband just because one could run there", () => {
    expect(decide(15_120, 1)).toEqual([]);
    expect(decide(14_880, 1)).toEqual([]);
  });

  it("turns a nudge round when it overshot", () => {
    expect(decide(14_880, 0.95)).toEqual([{ kind: "setRate", rate: 1.05 }]);
  });

  it("seeks a paused party rather than nudging one, and does not overshoot it", () => {
    // A rate moves nothing on a player that is not playing, so a nudge there
    // would never converge. A party that is not advancing has nothing to catch
    // up with, so overshooting it would simply be wrong.
    const still = adopted({ status: "paused", positionMs: 10_000 }, T0);
    const at = (localPositionMs: number) =>
      driftCommands({ adopted: still, localPositionMs, now: NOW, playbackRate: 1 });
    expect(seekTargetMs(still, NOW)).toBe(10_000);
    expect(at(10_100)).toEqual([]);
    expect(at(10_150)).toEqual([{ kind: "seek", positionMs: 10_000 }]);
    expect(at(10_600)).toEqual([{ kind: "seek", positionMs: 10_000 }]);
  });

  it("leaves an ended or empty party alone entirely", () => {
    for (const idle of [adopted({ status: "ended" }), adopted({ videoId: null })]) {
      expect(
        driftCommands({ adopted: idle, localPositionMs: 99_999, now: NOW, playbackRate: 1 }),
      ).toEqual([]);
    }
  });

  it("restores the rate before walking away from a party it stops correcting", () => {
    // Letting go of a correction is itself a rate change, so "nothing left to
    // correct" is not the same as "do nothing". A peer that walks away mid-nudge
    // watches the rest of the video five percent slow.
    expect(
      driftCommands({
        adopted: adopted({ status: "ended" }),
        localPositionMs: 99_999,
        now: NOW,
        playbackRate: 0.95,
      }),
    ).toEqual([{ kind: "setRate", rate: 1 }]);
    expect(decide(15_000, 0.95)).toEqual([{ kind: "setRate", rate: 1 }]);
  });
});

describe("the rate the player will actually accept", () => {
  /**
   * Measured, not read from the docs. YouTube floors a requested rate onto a
   * 0.05 grid and clamps it to [0.25, 2], and the two rates originally
   * specified are precisely the two that fail: 1.03 is a silent no-op, and 0.97
   * lands on 0.95 without being asked. Correction in one direction only, which
   * presents as flakiness because half of it works.
   */
  it("floors a requested rate onto the 0.05 grid", () => {
    expect(snapPlaybackRate(0.97)).toBe(0.95);
    expect(snapPlaybackRate(1.03)).toBe(1);
    expect(snapPlaybackRate(1.07)).toBe(1.05);
  });

  it("leaves the ladder's own rates exactly as they are", () => {
    // 0.95 divided by 0.05 is 19.000000004 in binary floating point, and
    // flooring that without an epsilon lands on 0.9. A ladder that asks for 0.95
    // and is handed 0.9 corrects five times harder than it meant to.
    expect(snapPlaybackRate(0.95)).toBe(0.95);
    expect(snapPlaybackRate(1.05)).toBe(1.05);
    expect(snapPlaybackRate(DEFAULT_LADDER.slowRate)).toBe(DEFAULT_LADDER.slowRate);
    expect(snapPlaybackRate(DEFAULT_LADDER.fastRate)).toBe(DEFAULT_LADDER.fastRate);
  });

  it("clamps to the range the player accepts", () => {
    expect(snapPlaybackRate(0.1)).toBe(0.25);
    expect(snapPlaybackRate(3)).toBe(2);
  });

  it("falls back to seeking when this player will not change rate at all", () => {
    /**
     * The feature detect: ask for 1.05 once at startup and read back. Silence
     * means the middle rung does nothing on this player, so it is removed rather
     * than left in to fail silently, and the deadband widens with it because a
     * seek costs a stall and half a second of drift is not worth one.
     */
    const degraded = setRateControl(createSession(), false);
    expect(degraded.ladder).toBe(SEEK_ONLY_LADDER);

    const party = adopted({ positionMs: 10_000 }, T0);
    const decide = (localPositionMs: number) =>
      driftCommands(
        { adopted: party, localPositionMs, now: T0 + 5_000, playbackRate: 1 },
        degraded.ladder,
      );
    expect(decide(15_500)).toEqual([]);
    expect(decide(14_500)).toEqual([]);
    expect(decide(16_001)).toEqual([{ kind: "seek", positionMs: 15_300 }]);
    // The same half second on a player that can nudge is corrected, which is
    // what makes this a fallback and not a second default.
    expect(
      driftCommands({ adopted: party, localPositionMs: 15_500, now: T0 + 5_000, playbackRate: 1 }),
    ).toEqual([{ kind: "setRate", rate: 0.95 }]);
  });

  it("puts the fallback where every tick reads it, not where a caller must remember it", () => {
    // 300ms ahead of the party: inside the nudge band on a player that can
    // nudge, and inside the widened deadband on one that cannot.
    const start = watching();
    const drifted = event({ kind: "position", positionMs: 12_800, jumpedFromMs: null });
    const degraded = setRateControl(start.session, false);
    expect(applyPlayerEvent(degraded, drifted, ME, start.at + 500).commands).toEqual([]);
    expect(
      applyPlayerEvent(setRateControl(degraded, true), drifted, ME, start.at + 500).commands,
    ).toEqual([{ kind: "setRate", rate: 0.95 }]);
  });

  it("forgets the rate across a load, because the player resets it", () => {
    // Carrying the assumption over would make correction work on the first video
    // of an evening and silently fail on every one after it, which is the same
    // "looks intermittent" shape as the asymmetry above and just as hard to
    // attribute.
    let session = applyPlayerEvent(
      applyRemoteState(createSession(), state(), T0).session,
      event({ kind: "rate", rate: 0.95 }),
      ME,
      T0 + 100,
    ).session;
    expect(session.local.rate).toBe(0.95);
    session = applyRemoteState(session, state({ videoId: OTHER_VIDEO, rev: 2 }), T0 + 200).session;
    expect(session.local.rate).toBe(1);
    expect(session.local.loadedVideoId).toBe(OTHER_VIDEO);
  });

  it("takes the resolved rate from the player and never the one it asked for", () => {
    const effects = applyPlayerEvent(createSession(), event({ kind: "rate", rate: 0.95 }), ME, T0);
    expect(effects.session.local.rate).toBe(0.95);
    expect(effects.broadcast).toBeNull();
    expect(effects.commands).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Resending                                                                   */
/* -------------------------------------------------------------------------- */

describe("resending what the room never echoed", () => {
  const acted = () =>
    mustWrite(
      applyLocalAction(
        createSession(),
        { videoId: VIDEO, status: "playing", positionMs: 10_000 },
        ME,
        T0,
      ),
    );

  it("waits half a second out before saying anything again", () => {
    const { session } = acted();
    expect(nextResendAt(session)).toBe(T0 + 500);
    expect(resendUnconfirmed(session, T0 + 499, 10_499)).toBeNull();
    expect(resendUnconfirmed(session, T0 + 500, 10_500)).not.toBeNull();
  });

  it("doubles the wait and stops doubling at four seconds", () => {
    // No attempt limit: giving up leaves this peer holding the highest rev and
    // ignoring the room forever, which is worse than a small frame every four
    // seconds.
    let session = acted().session;
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const at = nextResendAt(session);
      if (at === null) throw new Error("nothing was pending");
      waits.push(at - (session.pending?.sentAt ?? 0));
      const again = resendUnconfirmed(session, at, 10_000);
      if (again === null) throw new Error("nothing was due");
      session = again.session;
    }
    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 4_000, 4_000]);
  });

  it("re-samples a playing state rather than replaying it", () => {
    /**
     * The receiver stamps arrival and measures from that, so it treats whatever
     * it gets as current. Replaying a sample taken two seconds ago therefore
     * puts the whole room two seconds late, by exactly the backoff that
     * delivered it.
     */
    const { session, broadcast } = acted();
    const again = resendUnconfirmed(session, T0 + 2_000, 12_000);
    expect(again?.broadcast?.state).toEqual({
      ...broadcast?.state,
      positionMs: 12_000,
      atMs: T0 + 2_000,
    });
  });

  it("keeps rev and actorId across a resend", () => {
    // The rev is how this peer recognises its own echo, and bumping it would
    // turn a retry into a new write that other peers feel obliged to answer.
    const { session, broadcast } = acted();
    const again = resendUnconfirmed(session, T0 + 2_000, 12_000);
    expect(again?.broadcast?.state?.rev).toBe(broadcast?.state?.rev);
    expect(again?.broadcast?.state?.actorId).toBe(ME);
  });

  it("is ignored by a peer that already applied the original, which needs no correction", () => {
    /**
     * This looks like a hole and is not, so do not close it. Equal rev and equal
     * actor is not a win, so a peer that received the original drops the
     * corrected copy. That is right: it stamped its own arrival time and its own
     * arithmetic already lands on exactly the number the correction carries. The
     * resend exists for peers who never received the original at all, and they
     * stamp this one on arrival and get the right answer too.
     */
    const { session, broadcast } = acted();
    const original = broadcast?.state;
    if (!original) throw new Error("no write was made");

    // Arrival at T0 keeps the arithmetic exact; in the field the only error left
    // is one-way latency, which is what the deadband is sized for.
    const peer = applyRemoteState(createSession(), original, T0).session;
    const corrected = resendUnconfirmed(session, T0 + 2_000, 12_000)?.broadcast?.state;
    if (!corrected) throw new Error("no resend was made");

    const after = applyRemoteState(peer, corrected, T0 + 2_000);
    expect(after.applied).toBe(false);
    expect(after.commands).toEqual([]);
    expect(currentState(after.session)).toEqual(original);
    expect(expectedPositionMs(after.session.adopted!, T0 + 2_000)).toBe(corrected.positionMs);
  });

  it("replays a paused or an ended state verbatim, live position and all", () => {
    // Their positions do not advance, so there is nothing to re-sample and the
    // live position is not theirs to take.
    for (const status of ["paused", "ended"] as const) {
      const result = mustWrite(
        applyLocalAction(
          createSession(),
          { videoId: VIDEO, status, positionMs: 10_000 },
          ME,
          T0,
        ),
      );
      const again = resendUnconfirmed(result.session, T0 + 2_000, 55_555);
      expect(again?.broadcast?.state, status).toEqual(result.broadcast?.state);
    }
  });

  it("replays a teardown as a teardown", () => {
    const session = applyRemoteState(createSession(), state({ rev: 4 }), T0).session;
    const closed = applyLocalTeardown(session, T0 + 100);
    const again = resendUnconfirmed(closed.session, T0 + 700, 10_000);
    expect(again?.broadcast).toEqual({ type: "set-watch-party", state: null });
  });

  it("advances by its own clock when there is no player to sample", () => {
    // Our own `atMs` is our own clock on both sides of that subtraction, which
    // is the one place in this module where subtracting it is not the bug the
    // contract warns about.
    const { session } = acted();
    const again = resendUnconfirmed(session, T0 + 2_000, null);
    expect(again?.broadcast?.state?.positionMs).toBe(12_000);
  });

  it("stops once the room echoes the write back", () => {
    const { session, broadcast } = acted();
    const echoed = applyRemoteState(session, broadcast?.state ?? null, T0 + 100).session;
    expect(echoed.pending).toBeNull();
    expect(nextResendAt(echoed)).toBeNull();
    expect(resendUnconfirmed(echoed, T0 + 9_000, 12_000)).toBeNull();
  });

  it("stops once somebody outranks the write, rather than retrying forever", () => {
    // A retry against a room that has moved past it can never succeed and would
    // never stop.
    const { session } = acted();
    const outranked = applyRemoteState(session, state({ rev: 9, actorId: "peer-z" }), T0 + 100)
      .session;
    expect(outranked.pending).toBeNull();
    expect(resendUnconfirmed(outranked, T0 + 9_000, 12_000)).toBeNull();
  });

  it("keeps waiting while the frames going past are older than the write", () => {
    const { session } = acted();
    const stale = applyRemoteState(session, state({ rev: 0, actorId: "peer-z" }), T0 + 100).session;
    expect(stale.pending).not.toBeNull();
    expect(resendUnconfirmed(stale, T0 + 500, 10_500)).not.toBeNull();
  });

  it("follows the room back in rather than insisting on a teardown it asked for", () => {
    const session = applyRemoteState(createSession(), state({ rev: 4 }), T0).session;
    const closed = applyLocalTeardown(session, T0 + 100);
    const alive = applyRemoteState(closed.session, state({ rev: 5, actorId: "peer-z" }), T0 + 200);
    expect(alive.applied).toBe(true);
    expect(alive.session.pending).toBeNull();
  });

  it("recovers the room a dropped PAUSE would otherwise split in half", () => {
    /**
     * The failure this whole mechanism exists for, end to end. The pause is
     * dropped by the server's limiter. Its author now holds the highest rev, so
     * it ignores everything the room says, and the room never hears the pause:
     * two halves, permanently, with no path back and nothing on either side able
     * to tell.
     */
    const start = watching();
    const paused = mustWrite(
      applyLocalAction(start.session, { status: "paused", positionMs: 12_000 }, ME, start.at),
    );

    // The room, still playing, at the rev before ours. We ignore it, correctly.
    const ignored = applyRemoteState(
      paused.session,
      state({ status: "playing", positionMs: 12_500, rev: 1, actorId: "peer-a" }),
      start.at + 200,
    );
    expect(ignored.applied).toBe(false);
    expect(currentState(ignored.session)?.status).toBe("paused");

    // The retry goes out, and this time the room echoes it.
    const retry = resendUnconfirmed(ignored.session, start.at + 500, 12_000);
    expect(retry?.broadcast?.state?.status).toBe("paused");
    const settled = applyRemoteState(
      retry!.session,
      retry?.broadcast?.state ?? null,
      start.at + 700,
    ).session;
    expect(settled.pending).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* A failed player is a reader                                                 */
/* -------------------------------------------------------------------------- */

describe("a participant whose player has failed", () => {
  const broken = () => {
    const start = watching();
    return applyPlayerEvent(start.session, event({ kind: "failed", failure: failure(150) }), ME, start.at + 100)
      .session;
  };

  it("is refused when it tries to write", () => {
    expect(broken().playerFailed).toBe(true);
    expect(applyLocalAction(broken(), { status: "paused", positionMs: 0 }, ME, T0 + 9_000)).toBeNull();
  });

  it("never announces the position 0 a dead player reports forever", () => {
    /**
     * The whole reason for the ban. Position 0 on a fresh rev outranks everybody
     * and drags the room back to the start of the video, and one person's broken
     * embed must not be able to do that. This is the difference between the
     * failure paths being handled and merely being displayed.
     */
    const played = feed(broken(), [
      { at: T0 + 60_000, event: { kind: "phase", phase: "paused", positionMs: 0 } },
      { at: T0 + 60_250, event: { kind: "position", positionMs: 0, jumpedFromMs: null } },
      { at: T0 + 60_500, event: { kind: "phase", phase: "playing", positionMs: 0 } },
    ]);
    expect(played.broadcasts).toEqual([null, null, null]);
  });

  it("never announces a dead player's collapse to zero as a scrub either", () => {
    /**
     * The same ban on the other path, and it is reachable: a failed player is
     * still handed a load when the room changes video, so its position events
     * are read again. Falling from 90s to 0 is a discontinuity by every
     * measure, the player reports it as one without an opinion, and taking it
     * at face value writes position 0 on a fresh rev. That is the same room
     * reset arriving through a different door.
     */
    const reloaded = applyRemoteState(
      broken(),
      state({ videoId: OTHER_VIDEO, status: "playing", positionMs: 90_000, rev: 5 }),
      T0 + 9_000,
    ).session;
    const played = feed(reloaded, [
      { at: T0 + 11_000, event: { kind: "phase", phase: "playing", positionMs: 0 } },
      { at: T0 + 14_000, event: { kind: "position", positionMs: 0, jumpedFromMs: 93_000 } },
    ]);
    expect(played.broadcasts).toEqual([null, null]);
  });

  it("keeps resending a write it made while the player still worked", () => {
    // Abandoning it is how a peer that already sent a PAUSE ends up holding the
    // highest rev and ignoring the room forever, which is the exact split the
    // resend exists to prevent.
    const start = watching();
    const mine = mustWrite(
      applyLocalAction(start.session, { status: "paused", positionMs: 12_000 }, ME, start.at),
    );
    const failed = applyPlayerEvent(
      mine.session,
      event({ kind: "failed", failure: failure(153) }),
      ME,
      start.at + 100,
    ).session;
    expect(failed.pending).toEqual(mine.session.pending);
    expect(resendUnconfirmed(failed, start.at + 500, null)?.broadcast?.state).toEqual(
      mine.broadcast?.state,
    );
  });

  it("still follows the room, because it is a reader and not a stranger", () => {
    const followed = applyRemoteState(
      broken(),
      state({ status: "paused", positionMs: 44_000, rev: 5 }),
      T0 + 9_000,
    );
    expect(followed.applied).toBe(true);
    expect(currentState(followed.session)?.positionMs).toBe(44_000);
  });

  it("may still end the party, which carries no position to drag anybody back", () => {
    // Somebody whose embed will not play is exactly the person who wants to
    // close the thing.
    const closed = applyLocalTeardown(broken(), T0 + 9_000);
    expect(closed.broadcast).toEqual({ type: "set-watch-party", state: null });
    expect(currentState(closed.session)).toBeNull();
  });

  it("becomes a writer again when a fresh player is ready", () => {
    const recovered = applyPlayerEvent(broken(), event({ kind: "ready" }), ME, T0 + 9_000);
    expect(recovered.session.playerFailed).toBe(false);
    expect(recovered.commands).toEqual([
      { kind: "load", videoId: VIDEO, positionMs: 19_000 },
      { kind: "play" },
    ]);
    expect(
      applyLocalAction(recovered.session, { status: "paused", positionMs: 19_000 }, ME, T0 + 10_500),
    ).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* A regression this suite caught                                              */
/* -------------------------------------------------------------------------- */

describe("joining a party while the network is slow", () => {
  /**
   * THIS TEST WAS RED WHEN IT WAS WRITTEN, and it is kept because the thing it
   * caught is invisible from the seat of the person who causes it.
   *
   * A peer joins a playing party, is cued to 10s, and its player takes three
   * seconds to buffer, which is an ordinary cold start rather than a bad day.
   * PLAYING then fires carrying the position it was cued to, long after the one
   * second window has shut. The echo guard used to compare that position
   * against a room now expecting 13s, see three seconds of difference, call it
   * a user action, and put `playing@10_000` on a fresh rev. Every other peer
   * then seeks backwards by however long this one took to buffer, on every slow
   * join, and the person it happened to saw nothing at all.
   *
   * The guard now compares the video and the phase and not the position, so the
   * slow join says nothing and a real scrub is caught by `onPosition`, where
   * the number has actually landed.
   */
  it("does not announce its own buffering delay as a user action", () => {
    const joined = applyRemoteState(
      createSession(),
      state({ status: "playing", positionMs: 10_000, rev: 1 }),
      T0,
    );
    expect(joined.commands).toEqual([
      { kind: "load", videoId: VIDEO, positionMs: 10_000 },
      { kind: "play" },
    ]);

    const late = applyPlayerEvent(
      joined.session,
      event({ kind: "phase", phase: "playing", positionMs: 10_000 }),
      ME,
      T0 + 3_000,
    );
    expect(late.broadcast).toBeNull();
    expect(late.session.maxSeenRev).toBe(1);
  });

  it("still lets that peer act the moment somebody actually does something", () => {
    // The fix suppresses more than it used to, so this is the guard against it
    // suppressing everything.
    const joined = applyRemoteState(
      createSession(),
      state({ status: "playing", positionMs: 10_000, rev: 1 }),
      T0,
    ).session;
    const buffered = feed(joined, [
      { at: T0 + 3_000, event: { kind: "phase", phase: "playing", positionMs: 10_000 } },
    ]).session;
    const pausedByHand = applyPlayerEvent(
      buffered,
      event({ kind: "phase", phase: "paused", positionMs: 13_000 }),
      ME,
      T0 + 4_000,
    );
    expect(pausedByHand.broadcast?.state).toMatchObject({
      status: "paused",
      positionMs: 13_000,
      rev: 2,
      actorId: ME,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Reading a pasted link                                                       */
/* -------------------------------------------------------------------------- */

describe("reading a pasted link", () => {
  it("reads every share form YouTube hands out", () => {
    const forms = [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
      "http://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "https://www.youtube.com/v/dQw4w9WgXcQ",
    ];
    for (const form of forms) {
      expect(parseYouTubeUrl(form), form).toEqual({ videoId: VIDEO, startMs: 0 });
    }
  });

  it("reads a link pasted without its scheme or with whitespace round it", () => {
    expect(parseYouTubeUrl("youtu.be/dQw4w9WgXcQ")).toEqual({ videoId: VIDEO, startMs: 0 });
    expect(parseYouTubeUrl("www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      videoId: VIDEO,
      startMs: 0,
    });
    expect(parseYouTubeUrl("  https://youtu.be/dQw4w9WgXcQ\n")).toEqual({
      videoId: VIDEO,
      startMs: 0,
    });
  });

  it("reads the timestamp in every form a share link writes it", () => {
    const offsets: [string, number][] = [
      ["https://youtu.be/dQw4w9WgXcQ?t=90", 90_000],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s", 90_000],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s", 90_000],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s", 3_723_000],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2h", 7_200_000],
      ["https://www.youtube.com/embed/dQw4w9WgXcQ?start=42", 42_000],
    ];
    for (const [url, startMs] of offsets) {
      expect(parseYouTubeUrl(url), url).toEqual({ videoId: VIDEO, startMs });
    }
  });

  it("keeps the link when the timestamp is unreadable", () => {
    // Landing at zero is a small annoyance. Refusing the link over it is a large
    // one.
    expect(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=soon")).toEqual({
      videoId: VIDEO,
      startMs: 0,
    });
  });

  it("plays the video and ignores the playlist riding along with it", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0000000000")).toEqual(
      { videoId: VIDEO, startMs: 0 },
    );
  });

  it("matches the host on a dot boundary and not on a substring", () => {
    // `youtube.com.example.net` is somebody else's host and reads as ours to a
    // careless check. Handing an eleven character fragment of one of their URLs
    // to the player produces a broken embed with no explanation, whereas a
    // rejection is a sentence the UI can show.
    expect(parseYouTubeUrl("https://youtube.com.example.net/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseYouTubeUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseYouTubeUrl("https://myyoutu.be/dQw4w9WgXcQ")).toBeNull();
    expect(parseYouTubeUrl("https://youtube.com.br/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).not.toBeNull();
  });

  it("rejects anything that is not a YouTube video, rather than guessing", () => {
    const rejected = [
      "",
      "   ",
      "hello world",
      "https://vimeo.com/123456789",
      "javascript:alert(1)",
      "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/playlist?list=PL0000000000",
      "https://www.youtube.com/@rafa",
      "https://www.youtube.com/watch",
      "https://www.youtube.com/watch?v=tooshort",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQextra",
      "https://www.youtube.com/watch?v=dQw4w9WgXc!",
      "https://youtu.be/",
      "https://www.youtube.com/shorts/",
    ];
    for (const input of rejected) {
      expect(parseYouTubeUrl(input), input).toBeNull();
    }
  });

  it("reads a timestamp on its own terms", () => {
    expect(parseTimestampSeconds("90")).toBe(90);
    expect(parseTimestampSeconds("90s")).toBe(90);
    expect(parseTimestampSeconds("1h2m3s")).toBe(3_723);
    expect(parseTimestampSeconds("1h")).toBe(3_600);
    expect(parseTimestampSeconds("2M")).toBe(120);
    expect(parseTimestampSeconds("")).toBeNull();
    expect(parseTimestampSeconds("soon")).toBeNull();
    expect(parseTimestampSeconds("-30")).toBeNull();
    expect(parseTimestampSeconds("90.5")).toBeNull();
    expect(parseTimestampSeconds("99999999999999999999")).toBeNull();
  });
});

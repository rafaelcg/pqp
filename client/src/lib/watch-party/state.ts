import {
  setWatchPartyMessageSchema,
  watchPartyMessageSchema,
  type SetWatchPartyMessage,
  type WatchPartyMessage,
  type WatchPartyState,
} from "@pqp/shared";

/**
 * Watching together, as arithmetic. No player, no socket, no React.
 *
 * Every decision this feature makes lives here: which of two conflicting states
 * survives, what number the next local action carries, which player events were
 * a person and which were us, how far out of step a player is allowed to drift
 * before anybody touches it, and what a pasted link means. All of it is a pure
 * function of its arguments, `now` included, so the whole of it is pinned by a
 * suite with no DOM, no fake timers and no network. See `docs/WATCH_PARTY.md`
 * for why the split is this way round; the short version is that the drift
 * ladder needs the remote state and the local position together, and this is
 * the only module holding both.
 *
 * The player is an imperative shell that obeys `PlayerCommand` and reports flat
 * facts. It holds no opinion, so there is nowhere else for a decision to hide.
 *
 * ONE CLOCK, AND IT IS THE RECEIVER'S. Nothing here subtracts a sender's `atMs`
 * from a local `now`. See `AdoptedState`.
 *
 * NO YOUTUBE DATA API. This repo is public, its terms forbid shipping a key in
 * it, and every question we need to ask about a link can be answered by reading
 * the link.
 */

/* -------------------------------------------------------------------------- */
/* What the player says, and what it is told                                   */
/* -------------------------------------------------------------------------- */

/*
 * THIS IS THE REDUCER'S INPUT ALPHABET, AND IT IS DECLARED HERE ON PURPOSE.
 *
 * `lib/watch-party/player.ts` imports every type in this section rather than
 * declaring its own, and the arrow points this way round for two reasons.
 *
 * The mechanical one: this module is pure and depends on nothing. Importing
 * from the player would couple the reducer to the file that owns `HTMLElement`
 * and `window.YT`, and would leave a door open for somebody to add a value
 * export later and make the coupling real.
 *
 * The conceptual one, which is the one that matters: THE PLAYER IS THE
 * REPLACEABLE HALF. These are the facts the reducer knows how to fold and the
 * commands it knows how to issue. Declared here, a second player writes to the
 * alphabet; declared in the player, the reducer is rewritten for every new
 * player.
 *
 * IT WAS DECLARED IN BOTH ONCE, and that is the whole reason `docs/WATCH_PARTY.md`
 * has a section called "Two green suites can still not be a feature". Two
 * structurally similar declarations in two files are not a shared contract:
 * three of the five event names disagreed, both suites were green against their
 * own fiction, and neither module had ever been handed the other's output. If
 * you find yourself about to write a second copy of any type below, that is the
 * bug, not the fix.
 */

/**
 * What the player is doing. The player maps its own state codes onto these.
 *
 * `cued` and `buffering` and `unstarted` are on the way to somewhere rather
 * than somewhere, which is why `onPhase` refuses to broadcast any of the
 * three: the wire has no word for them and inventing one would have every peer
 * announce every stall.
 */
export type PlaybackPhase =
  | "unstarted"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "cued";

/**
 * Why one participant's player will not play, in the vocabulary the UI reads.
 *
 * Part of the alphabet rather than the player's own type for the same reason
 * as everything else here: a failure is a fact the reducer folds. The MAPPING
 * from a given player's error codes onto these names is emphatically not part
 * of the alphabet and lives with the player that produces the codes, in
 * `describeYouTubeError`.
 *
 * `ageRestricted` IS IN THIS UNION AND THE YOUTUBE PLAYER CANNOT PRODUCE IT.
 * Read the note on `describeYouTubeError` before wiring anything to it.
 */
export type PlaybackFailureReason =
  | "notPlayable"
  | "ageRestricted"
  | "refererBlocked"
  | "videoUnavailable"
  | "playerFailed";

export interface PlayerFailure {
  reason: PlaybackFailureReason;
  /** The raw player code, or null when the failure is ours rather than theirs. */
  code: number | null;
  videoId: string | null;
  /**
   * True when the fix belongs to this deployment or this machine, not to the
   * person who clicked.
   *
   * Error 153 and a script that never loaded are the two. The distinction is
   * the reason 153 is separated from the rest: every other card reads as "pick
   * a different video", and saying that when the video is fine sends somebody
   * off to fail four more times.
   */
  environmental: boolean;
  /** The escape hatch, which every failure gets. Null when there is no video. */
  watchOnYouTubeUrl: string | null;
}

/**
 * Flat facts from the player. Not intents.
 *
 * The player cannot tell a person pressing pause from us telling it to pause,
 * because the IFrame API fires the same event for both, so it does not try. It
 * reports what happened and this module decides what it meant.
 */
export type PlayerEvent =
  /** The handle exists and commands will now run. */
  | { kind: "ready" }
  /**
   * The player changed phase.
   *
   * `positionMs` is what the player answered at the instant the event fired,
   * and IT CAN BE STALE. A programmatic seek fires BUFFERING and PLAYING
   * *before* the seek lands, so this reads the old position. It is carried
   * anyway because re-reading it a tick later is no fresher, and this module is
   * where the staleness is handled: `SUPPRESSION_WINDOW_MS` is sized for it.
   */
  | { kind: "phase"; phase: PlaybackPhase; positionMs: number }
  /**
   * WHERE THE PLAYER IS, ON EVERY POLL. Roughly every 250ms while a party is
   * loaded, whether or not anything surprising happened.
   *
   * TWO CONSUMERS READ THIS EVENT AND BOTH MUST BE FED, which is why it carries
   * two facts rather than being split into two events. The drift ladder needs a
   * continuous position on every sample; scrub handling needs the rare
   * discontinuity. Splitting them and emitting only on a discontinuity starves
   * the ladder silently, which is the same shape of bug as the vocabulary split
   * this event was born out of, just pointing the other way.
   *
   * `jumpedFromMs` IS THE DISCONTINUITY, and null means the position arrived
   * where the player's own clock predicted. Non-null carries the prediction it
   * left, which is what makes the size of the jump readable rather than merely
   * its existence.
   *
   * WHOSE JUMP IT IS, IS NOT THE PLAYER'S QUESTION. A hand on the scrubber, a
   * seek this peer issued a moment ago and a long rebuffer are indistinguishable
   * at the player, so it reports all three identically and `onPosition` decides,
   * using the suppression window the player has no access to.
   */
  | { kind: "position"; positionMs: number; jumpedFromMs: number | null }
  /**
   * The RESOLVED rate, from `onPlaybackRateChange` and never from the value we
   * asked for. The two differ: YouTube quantises a requested rate down onto a
   * 0.05 grid, and when the request resolves to the rate already in effect the
   * event does not fire at all. A requested 1.03 therefore produces silence and
   * a requested 0.97 produces an event saying 0.95.
   */
  | { kind: "rate"; rate: number }
  /** Terminal. No further commands will do anything. */
  | { kind: "failed"; failure: PlayerFailure };

/**
 * What the player is told to do. It obeys without judging.
 *
 * `load` is a cue or a load depending on what follows it, which is the player's
 * business: the two differ only in whether playback starts, and the command
 * after this one says whether it should.
 */
export type PlayerCommand =
  | { kind: "load"; videoId: string; positionMs: number }
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "seek"; positionMs: number }
  | { kind: "setRate"; rate: number };

/** Everything except a rate change moves playback, and moving playback is what needs covering. */
function movesPlayback(command: PlayerCommand): boolean {
  return command.kind !== "setRate";
}

/* -------------------------------------------------------------------------- */
/* The session                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A state, and THE RECEIVER'S clock when it arrived.
 *
 * The two are inseparable, which is why they are one type. Every position in
 * this file is measured from `adoptedAt` and never from the state's own `atMs`.
 * `atMs` is the sender's wall clock, and two consumer machines routinely
 * disagree by tens of seconds: a laptop resuming from sleep, a phone with the
 * time set by hand. `positionMs + (now - atMs)` therefore hands the whole room
 * to the worst clock in it, permanently, while the sender sees a party working
 * perfectly. Measuring from arrival leaves one-way latency as the only error,
 * which really is the ~100ms that sits inside the deadband. The long version is
 * in `packages/shared/src/watch-party.ts`.
 *
 * Pairing them in a type rather than passing two loose numbers is deliberate:
 * the mismatched pair is the bug, and this makes the mismatched pair hard to
 * build.
 */
export interface AdoptedState {
  readonly state: WatchPartyState;
  readonly adoptedAt: number;
}

/**
 * What one client knows about the party it is in.
 *
 * `maxSeenRev` is separate from the adopted state's `rev` on purpose. The rev of
 * a local action has to outrank everything this peer has ever heard, not merely
 * what it is currently showing, and the two diverge the moment a party is torn
 * down: the state goes to null while the conversation that produced rev 9 still
 * happened. Deriving the next rev from the current state there would restart at
 * 1 and lose every argument against a peer that kept counting.
 *
 * `pending` is the write this peer has sent and not yet heard back. The wire
 * contract makes the echo an acknowledgement rather than a courtesy: a state
 * the room never echoed has not happened, and a PAUSE dropped by the server's
 * limiter would otherwise leave this peer holding the highest rev, ignoring
 * every frame the room sends, split off from the room permanently.
 */
export interface WatchPartySession {
  /** The last state this peer adopted, and when. Every echo check is measured against it. */
  readonly adopted: AdoptedState | null;
  readonly maxSeenRev: number;
  /** A local write that has not been echoed back yet. Null when the room agrees with us. */
  readonly pending: PendingWrite | null;
  /**
   * The deadline of the echo suppression window. See `SUPPRESSION_WINDOW_MS`.
   * A deadline and not a flag, deliberately.
   */
  readonly suppressUntil: number;
  /**
   * READERS AND WRITERS. A participant whose player has failed (embedding
   * disabled, age restricted, error 153) must never write, because a dead
   * player reports position 0 forever and position 0 on a fresh rev outranks
   * everybody and drags the whole room back to the start of the video. One
   * broken embed cannot be allowed to do that, so the block lives here where it
   * is enforced and tested rather than in whichever component last remembered
   * the rule.
   */
  readonly playerFailed: boolean;
  /** What the local player last said about itself, which is not what the room believes. */
  readonly local: LocalPlayerView;
  /**
   * Which ladder this peer corrects with. It is in the session because whether
   * a rate nudge works at all is a runtime capability of this browser's player,
   * discovered by `setRateControl`, and not something the caller should have to
   * remember to pass on every event.
   */
  readonly ladder: DriftLadder;
}

export interface PendingWrite {
  /** The write as it now stands. Null is a teardown this peer asked for. */
  readonly state: WatchPartyState | null;
  /** When it last went on the wire, which is what the backoff is measured from. */
  readonly sentAt: number;
  readonly attempts: number;
}

export interface LocalPlayerView {
  /** What we last told this player to load, so we know whether a load is needed. */
  readonly loadedVideoId: string | null;
  /**
   * The player's own phase, which is NOT the room's `status`. The room is
   * playing, paused or ended; a player is also allowed to be buffering, cued or
   * unstarted. The two were both called `status` once and the confusion is
   * worth the rename.
   */
  readonly phase: PlaybackPhase;
  readonly positionMs: number;
  /** When that sample was taken, so the position can be predicted forward. */
  readonly atMs: number;
  /**
   * The last rate the player RESOLVED to, never the last one we asked for.
   * Reset to 1 on every load, because `loadVideoById` and `cueVideoById` reset
   * it and a carried-over assumption would make correction work on the first
   * video of an evening and quietly fail on every one after it.
   */
  readonly rate: number;
}

const NO_PLAYER: LocalPlayerView = {
  loadedVideoId: null,
  phase: "unstarted",
  positionMs: 0,
  atMs: 0,
  rate: 1,
};

export function createSession(): WatchPartySession {
  return {
    adopted: null,
    maxSeenRev: 0,
    pending: null,
    suppressUntil: 0,
    playerFailed: false,
    local: NO_PLAYER,
    ladder: DEFAULT_LADDER,
  };
}

/**
 * Record whether this player will actually change rate, as measured.
 *
 * THE PROBE, which belongs to the caller because it needs a player and a timer:
 * ask for 1.05 once at startup and watch for a `rate` event. YouTube quantises
 * down onto a 0.05 grid, so 1.05 is a value it accepts and the event carries
 * 1.05 back. Silence means the request was refused, and the only honest reading
 * of silence is that the middle rung of the ladder does nothing on this player.
 *
 * The grid is undocumented and contradicts the published API, which says only
 * the values from `getAvailablePlaybackRates()` are honoured. Treating it as a
 * runtime capability rather than an invariant is the whole point: if it ever
 * becomes true, this peer degrades to seeking instead of correcting nothing at
 * all while a test insists it corrects.
 */
export function setRateControl(
  session: WatchPartySession,
  supported: boolean,
): WatchPartySession {
  return { ...session, ladder: supported ? DEFAULT_LADDER : SEEK_ONLY_LADDER };
}

/** Sugar for the UI, which reads the state far more often than the clock beside it. */
export function currentState(session: WatchPartySession): WatchPartyState | null {
  return session.adopted?.state ?? null;
}

/** What a local user action asks for. */
export interface WatchPartyIntent {
  /**
   * Leave `undefined` to keep whatever is loaded, which is what a pause or a
   * seek wants. `null` clears the video without ending the party.
   */
  videoId?: string | null;
  status: WatchPartyState["status"];
  /** Fractions are fine. The player reports seconds as a float. */
  positionMs: number;
}

/**
 * Everything one input produces: the next session, what to say to the room, and
 * what to tell the local player.
 *
 * `broadcast` IS A MESSAGE AND NOT A STATE, for one reason: a teardown is a
 * state of null, so a bare `WatchPartyState | null` cannot tell "say nothing"
 * apart from "tell the room the party is over". Null here means silence.
 */
export interface WatchPartyEffects {
  session: WatchPartySession;
  broadcast: SetWatchPartyMessage | null;
  commands: PlayerCommand[];
}

/**
 * The result of hearing from somebody else.
 *
 * There is no broadcast in this type. Applying a remote state cannot answer it,
 * because if it could, two peers would answer each other forever: A tells B, B
 * rebroadcasts, A rebroadcasts, and the rev climbs until somebody closes the
 * tab. That is a property of the type and not a rule to remember, so no test
 * pins it; the mechanism that does the real work of not rebroadcasting is the
 * pair of guards in `applyPlayerEvent`, because the player will report our own
 * commands back to us as events indistinguishable from a person.
 */
export interface RemoteApplyResult {
  session: WatchPartySession;
  /** True when the adopted state changed, which is the only time the player is touched. */
  applied: boolean;
  commands: PlayerCommand[];
}

/* -------------------------------------------------------------------------- */
/* Last writer wins                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which of two states a peer must keep, decided without talking to anybody.
 *
 * Higher `rev` wins. Ties break on `actorId` lexically, by UTF-16 code unit and
 * deliberately not by `localeCompare`: a locale-aware comparison can order the
 * same two ids differently on two machines, and an ordering that is not
 * identical everywhere is not a tie break, it is a split brain. Total and
 * arbitrary beats meaningful and negotiable here.
 *
 * Equal rev and equal actor means the same write arriving twice, usually our
 * own echo or a resend of it. That is not a win, because treating it as one
 * would report a change the player then acts on for no reason.
 */
export function remoteStateWins(
  current: WatchPartyState | null,
  incoming: WatchPartyState,
): boolean {
  if (current === null) return true;
  if (incoming.rev !== current.rev) return incoming.rev > current.rev;
  return incoming.actorId > current.actorId;
}

/**
 * Fold a remote state into the session and say what the player must do about it.
 *
 * `now` is stamped onto the adopted state as its arrival time, and that stamp is
 * what every later position calculation measures from.
 *
 * `null` is a teardown, which is what the last participant leaving produces. It
 * clears the state and keeps `maxSeenRev`, because the revs that were spoken
 * were still spoken: a peer that starts the party again a second later must not
 * hand out numbers that a peer still holding the old count would outrank.
 *
 * A losing state still moves `maxSeenRev`. It is evidence of how far the
 * conversation got, and that is true whether or not it won.
 */
export function applyRemoteState(
  session: WatchPartySession,
  incoming: WatchPartyState | null,
  now: number,
): RemoteApplyResult {
  const pending = resolvePending(session.pending, incoming);

  if (incoming === null) {
    return {
      session: { ...session, adopted: null, pending },
      applied: session.adopted !== null,
      commands: [],
    };
  }

  const maxSeenRev = Math.max(session.maxSeenRev, incoming.rev);
  if (!remoteStateWins(currentState(session), incoming)) {
    return {
      session: { ...session, maxSeenRev, pending },
      applied: false,
      commands: [],
    };
  }

  const adopted: WatchPartySession = {
    ...session,
    adopted: { state: incoming, adoptedAt: now },
    maxSeenRev,
    pending,
  };
  const commands = reconcileCommands(adopted, now);
  return {
    session: withCommands(adopted, commands, now),
    applied: true,
    commands,
  };
}

/**
 * Parse a frame off the wire and fold it in, in one step.
 *
 * Validation is `watchPartyMessageSchema` and nothing else. Hand-rolling it
 * would mean a second definition of the wire drifting from the first, and this
 * frame arrives from another client, so a malformed one is not hypothetical.
 * Anything that does not parse is dropped without touching the session: there
 * is nothing useful to do with half a state, and a party that keeps playing is
 * a better failure than one that throws inside a socket handler.
 *
 * `channelId` is the channel this session belongs to. Pass it and a frame for
 * any other channel is ignored, which is cheaper than discovering later that a
 * second room's party moved this one's player.
 */
export function applyRemoteMessage(
  session: WatchPartySession,
  raw: unknown,
  now: number,
  channelId?: string,
): RemoteApplyResult {
  const message = decodeWatchPartyMessage(raw);
  if (message === null) return { session, applied: false, commands: [] };
  if (channelId !== undefined && message.channelId !== channelId) {
    return { session, applied: false, commands: [] };
  }
  return applyRemoteState(session, message.state, now);
}

/** The wire frame, or null when it is not one. Never throws. */
export function decodeWatchPartyMessage(raw: unknown): WatchPartyMessage | null {
  const parsed = watchPartyMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Is the write we are waiting on still worth waiting on.
 *
 * Three ways it stops being one, and only the first is success: the room echoed
 * it, somebody outranked it, or the party ended underneath it. Dropping a
 * superseded write matters as much as confirming a delivered one, because
 * resending a state the room has already moved past is a retry that can never
 * succeed and never stops.
 *
 * A pending teardown is cleared by anything at all. If the room answered with a
 * live state instead, this peer follows it back into the party rather than
 * insisting on ending something other people are still watching.
 */
function resolvePending(
  pending: PendingWrite | null,
  incoming: WatchPartyState | null,
): PendingWrite | null {
  if (pending === null) return null;
  if (pending.state === null) return null;
  if (incoming === null) return null;
  const confirmed =
    incoming.rev === pending.state.rev &&
    incoming.actorId === pending.state.actorId;
  if (confirmed) return null;
  return remoteStateWins(pending.state, incoming) ? null : pending;
}

/* -------------------------------------------------------------------------- */
/* Local actions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The local user did something, so this peer takes control.
 *
 * `rev` is `maxSeenRev + 1`, which is the whole of the "no host" design: acting
 * is how you become the authority, and having heard more of the conversation is
 * how you outrank somebody who acted at the same moment on less information.
 *
 * NULL MEANS THIS PEER IS NOT ALLOWED TO WRITE, which happens when its player
 * has failed. Callers must handle it; the UI should have hidden the control
 * long before it gets here, and this is the backstop for when it did not.
 *
 * The position is rounded because `getCurrentTime()` returns fractional seconds
 * and the wire schema takes an integer. Rounding here rather than at the caller
 * means a player wrapper cannot forget and have its frames silently rejected by
 * the server's parse.
 */
export function applyLocalAction(
  session: WatchPartySession,
  intent: WatchPartyIntent,
  actorId: string,
  now: number,
): WatchPartyEffects | null {
  if (session.playerFailed) return null;
  return writeLocalState(
    session,
    {
      videoId:
        intent.videoId === undefined
          ? (currentState(session)?.videoId ?? null)
          : intent.videoId,
      status: intent.status,
      positionMs: intent.positionMs,
    },
    actorId,
    now,
  );
}

/**
 * The shared tail of every local write: number it, adopt it, command the player,
 * say it to the room.
 *
 * Our own write is adopted with `adoptedAt` of now, exactly like a remote one.
 * It is the same clock either way, and going through the same field means the
 * drift arithmetic has no second case to get wrong.
 */
function writeLocalState(
  session: WatchPartySession,
  parts: Pick<WatchPartyState, "videoId" | "status"> & { positionMs: number },
  actorId: string,
  now: number,
): WatchPartyEffects {
  const at = Math.max(0, Math.round(now));
  const rev = session.maxSeenRev + 1;
  const state: WatchPartyState = {
    videoId: parts.videoId,
    status: parts.status,
    positionMs: Math.max(0, Math.round(parts.positionMs)),
    atMs: at,
    rev,
    actorId,
  };
  const written: WatchPartySession = {
    ...session,
    adopted: { state, adoptedAt: now },
    maxSeenRev: rev,
    pending: { state, sentAt: at, attempts: 1 },
  };
  const commands = reconcileCommands(written, now);
  return {
    session: withCommands(written, commands, now),
    broadcast: encodeSetWatchParty(state),
    commands,
  };
}

/**
 * End the party for everyone. The room is told, and this peer forgets the state.
 *
 * Allowed with a failed player, unlike every other write: somebody whose embed
 * will not play is exactly the person who wants to close the thing, and a
 * teardown carries no position to drag anybody backwards.
 */
export function applyLocalTeardown(
  session: WatchPartySession,
  now: number,
): WatchPartyEffects {
  return {
    session: {
      ...session,
      adopted: null,
      pending: {
        state: null,
        sentAt: Math.max(0, Math.round(now)),
        attempts: 1,
      },
    },
    broadcast: encodeSetWatchParty(null),
    commands: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Echo suppression                                                            */
/* -------------------------------------------------------------------------- */

/**
 * HOW LONG A PROGRAMMATIC CHANGE IS ALLOWED TO ECHO FOR.
 *
 * A deadline, cleared by the clock that is passed in, and never a flag cleared
 * by "the event we expect to see". Seeking to the position a player already
 * holds emits nothing, and telling an already paused player to pause emits
 * nothing, so a flag waiting for its event sticks the first time the event does
 * not come and then swallows every genuine user action after it, silently and
 * for the rest of the session.
 *
 * A second is long enough for a seek to land and its BUFFERING and PLAYING pair
 * to fire, measured at up to about 310ms on a real player, and short enough
 * that a person pressing pause immediately after somebody else pressed play is
 * still heard. Whatever this duration guesses wrong about, the semantic check
 * below catches.
 */
export const SUPPRESSION_WINDOW_MS = 1_000;

/**
 * How far a reported position may sit from the adopted one and still count as
 * the same position.
 *
 * The same 150ms as the default deadband and for the same reason, one-way
 * latency, but DELIBERATELY NOT THE LADDER'S deadband. A peer that falls back
 * to seek-only correction widens its ladder, and reading this number off the
 * ladder would widen this too, which would quietly stop that peer's genuine
 * half-second scrub from ever being broadcast.
 */
export const ECHO_POSITION_TOLERANCE_MS = 150;

/*
 * THE SCRUB THRESHOLD IS NOT HERE ANY MORE. It is `SEEK_DETECT_MS` in
 * `lib/watch-party/player.ts`, next to the poll loop that is the only thing
 * able to apply it.
 *
 * This module used to carry a second copy and a second detector, run against a
 * `tick` event the player never emitted. It therefore received no input at all
 * while the player's own findings had nowhere to go, and both suites stayed
 * green because each tested its own half. The rule that came out of it is in
 * `docs/WATCH_PARTY.md`: whoever owns the detection owns the threshold and the
 * suppression that goes with it, and the loser is deleted rather than left
 * dormant, because a dormant mechanism reads as coverage.
 */

/** Where the local player should be by now, going on what it last reported. */
function predictedLocalPosition(local: LocalPlayerView, now: number): number {
  if (local.phase !== "playing") return local.positionMs;
  return local.positionMs + Math.max(0, now - local.atMs);
}

/**
 * IS THIS A CHANGE FROM WHAT WE ADOPTED, or is it the room's own decision coming
 * back at us through the player.
 *
 * The second half of the echo guard, and the half that does not expire. The
 * window covers the transient where a programmatic seek reports the old
 * position; this covers everything the window's duration guessed wrong about,
 * including a player that took two seconds to buffer before it said anything.
 *
 * IT COMPARES THE VIDEO AND THE PHASE, AND DELIBERATELY NOT THE POSITION, which
 * is the fix for a defect that had a red test sitting on it: a peer joining a
 * playing party is cued to 10s, takes three seconds to buffer, and then reports
 * PLAYING carrying the position it was cued to. Long after the suppression
 * window has shut, a position comparison sees three seconds between that and a
 * room now expecting 13s, calls it a user action, and puts `playing@10_000` on
 * a fresh rev. The whole room then seeks backwards by however long this one
 * peer took to buffer, on every slow join, invisibly to the person who caused
 * it.
 *
 * DROPPING THE CLAUSE COSTS NOTHING, WHICH IS ONLY TRUE SINCE THE MERGE. A
 * phase event's position is documented in `player.ts` as unreliable by
 * construction: BUFFERING and PLAYING both fire *before* a seek lands, so the
 * number is the position being left rather than the one being gone to. It was
 * never the right witness for a scrub, and now it does not have to be one:
 * `onPosition` sees every poll and the player flags the discontinuity, so a
 * genuine scrub is caught there, with a position that has actually landed. One
 * question, one place it is answered.
 *
 * Note the direction of the change: removing a clause makes this guard
 * SUPPRESS MORE, never less, so it cannot open the oscillation the guard exists
 * to close.
 */
function isChangeFromAdopted(
  adopted: AdoptedState | null,
  candidate: {
    videoId: string | null;
    status: WatchPartyState["status"];
  },
): boolean {
  if (adopted === null) return false;
  if (adopted.state.videoId !== candidate.videoId) return true;
  return adopted.state.status !== candidate.status;
}

/**
 * Arm the window whenever a command will make the player emit events of its own.
 *
 * THIS MODULE NO LONGER REBASES ITS OWN POSITION AFTER ISSUING A SEEK, and the
 * deletion is deliberate rather than an oversight. It used to, optimistically,
 * so that its own scrub detector would not read its own seek as somebody
 * dragging the scrubber. That detector is gone: the player owns discontinuity
 * detection because the player owns the poll loop, and WHOEVER OWNS DETECTION
 * OWNS THE SUPPRESSION THAT GOES WITH IT. The player drops its baseline the
 * instant a seek is issued, which is one mechanism doing the job.
 *
 * Leaving a second, dormant copy here would be worse than useless. Two
 * suppression windows stacked on one another is a genuine user action landing
 * in the gap and being swallowed, and a dormant mechanism reads as coverage to
 * the next person. The position cache heals itself at the next `position`
 * event, roughly 250ms later.
 *
 * The suppression DEADLINE below is a different mechanism and stays. It covers
 * `phase` events, which a programmatic play, pause or seek fires exactly as a
 * person's would, and `docs/WATCH_PARTY.md` explains why it must be a deadline
 * on the injected clock rather than a flag waiting for an event that sometimes
 * never comes.
 */
function withCommands(
  session: WatchPartySession,
  commands: PlayerCommand[],
  now: number,
): WatchPartySession {
  let local = session.local;
  for (const command of commands) {
    if (command.kind === "load") {
      // A load resets the player's rate to 1 whether we like it or not.
      local = { ...local, loadedVideoId: command.videoId, rate: 1 };
    }
  }
  if (!commands.some(movesPlayback)) return { ...session, local };
  return {
    ...session,
    local,
    suppressUntil: Math.max(session.suppressUntil, now + SUPPRESSION_WINDOW_MS),
  };
}

/**
 * Bring the local player in line with the state this peer has adopted.
 *
 * Adoption is not drift. Somebody deliberately moved the party, so the seek
 * threshold here is the deadband and not the one second the ladder uses: the
 * jump has already happened for everybody else and matching it late is worse
 * than matching it now.
 */
function reconcileCommands(
  session: WatchPartySession,
  now: number,
): PlayerCommand[] {
  const adopted = session.adopted;
  if (adopted === null || adopted.state.videoId === null) return [];
  const { state } = adopted;
  const videoId = state.videoId;
  if (videoId === null) return [];
  const target = expectedPositionMs(adopted, now);

  if (session.local.loadedVideoId !== videoId) {
    const commands: PlayerCommand[] = [
      { kind: "load", videoId, positionMs: target },
    ];
    if (state.status === "playing") commands.push({ kind: "play" });
    else if (state.status === "paused") commands.push({ kind: "pause" });
    return commands;
  }

  // An ended party has nowhere to be. Seeking it back to its final second to
  // satisfy an arithmetic check would restart a video nobody asked to restart.
  if (state.status === "ended") return [];

  const commands: PlayerCommand[] = [];
  if (
    Math.abs(predictedLocalPosition(session.local, now) - target) >=
    ECHO_POSITION_TOLERANCE_MS
  ) {
    commands.push({ kind: "seek", positionMs: seekTargetMs(adopted, now) });
  }
  if (state.status === "playing" && session.local.phase !== "playing") {
    commands.push({ kind: "play" });
  }
  if (state.status === "paused" && session.local.phase === "playing") {
    commands.push({ kind: "pause" });
  }
  return commands;
}

/* -------------------------------------------------------------------------- */
/* Player events                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What one flat fact from the player means.
 *
 * This is where an event becomes an intent or becomes nothing, and it is the
 * only place that decision is made. Three things can silence an event, and all
 * three are load bearing: this peer is not allowed to write at all, the
 * suppression window is still open, or the event says nothing the adopted state
 * does not already say.
 */
export function applyPlayerEvent(
  session: WatchPartySession,
  event: PlayerEvent,
  actorId: string,
  now: number,
): WatchPartyEffects {
  switch (event.kind) {
    case "failed":
      // A reader from here on. The pending write survives, because it was made
      // while the player still worked and abandoning it is how a peer that
      // already sent a PAUSE ends up split from the room.
      //
      // `event.failure` IS DELIBERATELY NOT STORED HERE. Which sentence to show
      // is a question about one person's screen, and this session object is the
      // room's business; the container that owns the player already holds the
      // failure for the card. All the reducer needs is the one bit that changes
      // a decision it makes, which is that this peer may no longer write.
      return {
        session: { ...session, playerFailed: true, local: NO_PLAYER },
        broadcast: null,
        commands: [],
      };

    case "ready": {
      // A fresh player knows nothing, so this is a full reconcile: the load is
      // emitted because `loadedVideoId` is null again. This is also the path a
      // person's own "join watch party" click takes, which is the gesture the
      // browser's autoplay block wants.
      const ready = { ...session, playerFailed: false, local: NO_PLAYER };
      const commands = reconcileCommands(ready, now);
      return {
        session: withCommands(ready, commands, now),
        broadcast: null,
        commands,
      };
    }

    case "rate":
      // Recorded, never acted on. The ladder reads it next tick and decides
      // whether the correction it asked for actually took.
      return {
        session: { ...session, local: { ...session.local, rate: event.rate } },
        broadcast: null,
        commands: [],
      };

    case "phase":
      return onPhase(session, event, actorId, now);

    case "position":
      return onPosition(session, event, actorId, now);
  }
}

function onPhase(
  session: WatchPartySession,
  event: Extract<PlayerEvent, { kind: "phase" }>,
  actorId: string,
  now: number,
): WatchPartyEffects {
  const observed: WatchPartySession = {
    ...session,
    local: {
      ...session.local,
      phase: event.phase,
      positionMs: Math.max(0, event.positionMs),
      atMs: now,
    },
  };
  const quiet: WatchPartyEffects = {
    session: observed,
    broadcast: null,
    commands: [],
  };

  // Unstarted, buffering and cued are on the way to somewhere, not somewhere.
  // The wire has no word for any of them and inventing one would have every
  // peer announce every stall. `cued` is what a load leaves behind, so reading
  // it as a real phase would have every join broadcast its own arrival.
  if (
    event.phase === "buffering" ||
    event.phase === "unstarted" ||
    event.phase === "cued"
  ) {
    return quiet;
  }
  if (session.playerFailed) return quiet;
  if (now < session.suppressUntil) return quiet;

  const videoId = currentState(session)?.videoId ?? session.local.loadedVideoId;
  if (!isChangeFromAdopted(session.adopted, { videoId, status: event.phase })) {
    return quiet;
  }

  return writeLocalState(
    observed,
    { videoId, status: event.phase, positionMs: event.positionMs },
    actorId,
    now,
  );
}

/**
 * Where the player is, folded in, and what if anything to do about it.
 *
 * ONE EVENT, TWO JOBS, and both of them are read on every single poll. The
 * drift ladder reads `positionMs`. Scrub handling reads `jumpedFromMs`, which
 * the player sets when the position left the prediction its own clock made.
 *
 * THIS MODULE NO LONGER DETECTS THE SCRUB ITSELF. It used to run a second
 * detector, over a `tick` event the player never emitted, so it received no
 * input at all while the player's findings had nowhere to go and both suites
 * stayed green. See `docs/WATCH_PARTY.md`.
 *
 * A jump is read as a user intent, which is the one conclusion the player could
 * not have drawn. Our own programmatic seek arrives here as a jump too, and is
 * caught by the suppression window, which is why the window is checked before
 * the jump rather than after it.
 */
function onPosition(
  session: WatchPartySession,
  event: Extract<PlayerEvent, { kind: "position" }>,
  actorId: string,
  now: number,
): WatchPartyEffects {
  const sampled: WatchPartySession = {
    ...session,
    local: {
      ...session.local,
      positionMs: Math.max(0, event.positionMs),
      atMs: now,
    },
  };
  const adopted = session.adopted;
  const quiet: WatchPartyEffects = {
    session: sampled,
    broadcast: null,
    commands: [],
  };
  if (adopted === null || adopted.state.videoId === null) return quiet;
  if (now < session.suppressUntil) return quiet;

  if (event.jumpedFromMs !== null && !session.playerFailed) {
    return writeLocalState(
      sampled,
      {
        videoId: adopted.state.videoId,
        status: adopted.state.status,
        positionMs: event.positionMs,
      },
      actorId,
      now,
    );
  }

  const commands = driftCommands(
    {
      adopted,
      localPositionMs: event.positionMs,
      now,
      playbackRate: session.local.rate,
    },
    session.ladder,
  );
  return {
    session: withCommands(sampled, commands, now),
    broadcast: null,
    commands,
  };
}

/* -------------------------------------------------------------------------- */
/* Drift                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * THE DRIFT LADDER. Three bands, and the middle one is the reason there are
 * three.
 *
 * Under the deadband nothing happens at all, because one-way latency lives in
 * here and correcting noise is worse than carrying it.
 *
 * Between the deadband and a second, the rate moves by three percent until the
 * gap is back under the settle threshold. THIS BAND MUST NOT SEEK. A seek is a
 * black frame, a rebuffer and a jump, and doing that every few seconds to shave
 * a fifth of a second is how a watch party becomes unwatchable. Three percent
 * is inaudible on speech and closes 150ms in about five seconds.
 *
 * Over a second the gap is not something a rate can close in any tolerable
 * time, and at that size the person can see they are behind anyway, so it is a
 * seek and the jump is the lesser evil.
 *
 * The settle threshold is lower than the deadband on purpose. Restoring the
 * rate the instant the gap crosses back under 150ms would leave the player
 * sitting on the edge and re-triggering, so it has to come properly inside
 * before the correction is let go.
 *
 * WHY THE RATES ARE 0.95 AND 1.05 AND NOT THE 0.97 AND 1.03 THAT WERE
 * SPECIFIED. Measured in a browser rather than read from the docs: YouTube does
 * not restrict to `getAvailablePlaybackRates()` (that list is only what the
 * speed menu shows), it quantises the request down onto a 0.05 grid and clamps
 * it to [0.25, 2]. The two specified values are precisely the two that fail,
 * and they fail asymmetrically. A requested 1.03 stays at 1 and fires no event
 * at all. A requested 0.97 floors to 0.95 and fires. So a peer running ahead
 * would have slowed down at a rate it never asked for, and a peer running
 * behind would never have sped up at all: drift corrected in one direction
 * only, presenting as intermittent flakiness because half of it worked.
 *
 * Every rate this module asks for goes through `snapPlaybackRate`, so the
 * request and the resolved value agree. The grid is undocumented and
 * contradicts the published API, which is why `setRateControl` treats it as a
 * runtime capability and this stays a parameter rather than a literal in a
 * branch.
 */
export interface DriftLadder {
  deadbandMs: number;
  settleMs: number;
  seekMs: number;
  /** Used while the local player is ahead of the party. */
  slowRate: number;
  /** Used while it is behind. */
  fastRate: number;
  normalRate: number;
}

export const DEFAULT_LADDER: DriftLadder = {
  deadbandMs: 150,
  settleMs: 100,
  seekMs: 1_000,
  slowRate: 0.95,
  fastRate: 1.05,
  normalRate: 1,
};

/**
 * For a player that will not change rate, discovered by `setRateControl`.
 *
 * The middle rung is gone rather than widened, and the deadband goes with it:
 * seeking is the only tool left and a seek costs a stall, so the gap has to be
 * worth the interruption before anybody is interrupted. A peer on this ladder
 * is a second out of step at worst, which is noticeable and survivable, and it
 * is the honest outcome rather than a correction that silently does nothing.
 */
export const SEEK_ONLY_LADDER: DriftLadder = {
  deadbandMs: 1_000,
  settleMs: 1_000,
  seekMs: 1_000,
  slowRate: 1,
  fastRate: 1,
  normalRate: 1,
};

/** The grid YouTube floors a requested rate onto, and the range it clamps to. */
const RATE_GRID = 0.05;
const MIN_RATE = 0.25;
const MAX_RATE = 2;

/**
 * The rate the player will actually resolve to, worked out before asking.
 *
 * Asking for a value off the grid means the requested rate and the resolved
 * rate disagree, and everything downstream reads the resolved one, so the
 * ladder would spend every tick re-requesting a correction it believes is not
 * in effect. The epsilon is there because 0.95 divided by 0.05 is 19.000000004
 * in binary floating point and flooring that without it lands on 0.9.
 */
export function snapPlaybackRate(rate: number): number {
  const steps = Math.floor(rate / RATE_GRID + 1e-6);
  const snapped = Math.round(steps * RATE_GRID * 100) / 100;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, snapped));
}

/**
 * HOW FAR PAST THE TARGET A SEEK LANDS.
 *
 * A seek is never cheap. A 50ms seek was measured costing a 264ms buffering
 * stall, every time, so seeking to the exact expected position guarantees
 * arriving a quarter of a second behind it and needing another correction. Land
 * ahead by roughly the stall instead and the player comes back roughly level.
 *
 * This is also why the middle rung must never seek: correcting 150ms of drift
 * that way would cost more stall than the drift it fixed. Two other syncing
 * players do the same thing for the same reason, overshooting by a second and
 * by half a second.
 */
export const SEEK_OVERSHOOT_MS = 300;

export interface DriftInput {
  adopted: AdoptedState;
  /** Where the local player actually is, in ms. Fractions are fine. */
  localPositionMs: number;
  now: number;
  /** The rate the player reports, which is not always the rate it was asked for. */
  playbackRate: number;
}

/**
 * Where the party should be right now, measured from when this peer heard about
 * it and never from the sender's clock. See `AdoptedState`.
 *
 * Paused and ended do not advance, which is what makes them usable as the seek
 * target as well.
 */
export function expectedPositionMs(adopted: AdoptedState, now: number): number {
  if (adopted.state.status !== "playing") return adopted.state.positionMs;
  // Both sides of this subtraction are the same machine's clock, so the floor
  // only guards a caller passing a `now` from before the adoption.
  return adopted.state.positionMs + Math.max(0, now - adopted.adoptedAt);
}

/**
 * Where to seek to, which is past where the party is rather than at it. See
 * `SEEK_OVERSHOOT_MS`. A paused party is not moving, so there is nothing to
 * catch up with and overshooting it would just be wrong.
 */
export function seekTargetMs(adopted: AdoptedState, now: number): number {
  const expected = expectedPositionMs(adopted, now);
  return adopted.state.status === "playing"
    ? expected + SEEK_OVERSHOOT_MS
    : expected;
}

/** Positive means the local player is ahead of the party. Rounded, so a band edge cannot wobble on a float. */
export function driftMs(
  adopted: AdoptedState,
  localPositionMs: number,
  now: number,
): number {
  return Math.round(localPositionMs - expectedPositionMs(adopted, now));
}

/**
 * What the player should do about the gap, as commands it obeys without
 * judging. An empty array is the common case and means leave it alone.
 *
 * `setRate` covers restoring as well as correcting, so the player has exactly
 * one code path for a rate and no opinion about which is which.
 *
 * A paused party skips the middle band entirely: a playback rate does nothing
 * to a player that is not playing, so a nudge there would never converge. It
 * also costs nothing to seek, because there is no frame being watched to
 * interrupt.
 */
export function driftCommands(
  input: DriftInput,
  ladder: DriftLadder = DEFAULT_LADDER,
): PlayerCommand[] {
  const { adopted, playbackRate } = input;
  const { state } = adopted;
  // Letting go of a correction is itself a rate change, so "nothing to correct"
  // is not always "do nothing".
  const settled: PlayerCommand[] =
    playbackRate === ladder.normalRate
      ? []
      : [{ kind: "setRate", rate: ladder.normalRate }];

  if (state.videoId === null || state.status === "ended") return settled;

  const drift = driftMs(adopted, input.localPositionMs, input.now);
  const gap = Math.abs(drift);
  const seek: PlayerCommand[] = [
    { kind: "seek", positionMs: seekTargetMs(adopted, input.now) },
  ];
  // Ahead of the party slows down, behind it speeds up.
  const nudge: PlayerCommand[] = [
    {
      kind: "setRate",
      rate: snapPlaybackRate(drift > 0 ? ladder.slowRate : ladder.fastRate),
    },
  ];
  // A ladder whose nudge rates are the normal rate has no middle rung at all,
  // which is what a player that refuses to change rate leaves us with.
  const canNudge =
    ladder.slowRate !== ladder.normalRate ||
    ladder.fastRate !== ladder.normalRate;

  if (state.status === "paused") {
    return gap >= ladder.deadbandMs ? seek : settled;
  }
  if (gap > ladder.seekMs) return seek;
  if (!canNudge) return settled;
  if (gap >= ladder.deadbandMs) return nudge;
  // Inside the deadband but not yet settled: a correction already running keeps
  // running, and its direction is recomputed in case it overshot.
  if (playbackRate !== ladder.normalRate && gap >= ladder.settleMs) return nudge;
  return settled;
}

/* -------------------------------------------------------------------------- */
/* Resending what the room never echoed                                        */
/* -------------------------------------------------------------------------- */

/**
 * Backoff, doubling, capped.
 *
 * The base is not smaller because the server coalesces position-only updates,
 * and retrying inside that window is just more to coalesce. The cap is not
 * larger because four seconds out of step is already a person asking what
 * happened. There is no attempt limit: giving up leaves this peer holding the
 * highest rev and ignoring the room forever, which is worse than one small
 * frame every four seconds, and it stops on its own the moment the write is
 * confirmed or outranked.
 */
export const RESEND_BASE_MS = 500;
export const RESEND_MAX_MS = 4_000;

/** When the unconfirmed write should go out again, or null when nothing is waiting. */
export function nextResendAt(session: WatchPartySession): number | null {
  const pending = session.pending;
  if (pending === null) return null;
  const backoff = Math.min(
    RESEND_MAX_MS,
    RESEND_BASE_MS * 2 ** (pending.attempts - 1),
  );
  return pending.sentAt + backoff;
}

/**
 * The unconfirmed write, again, or null when nothing is due.
 *
 * A PLAYING STATE IS RE-SAMPLED AND RESTAMPED. It cannot be replayed, and the
 * reason is the receiver-stamped clock: a receiver treats every frame it gets
 * as current, so a sample taken two seconds ago arriving now puts the whole
 * room two seconds late, which is exactly the length of the backoff that
 * delivered it. `paused` and `ended` are replayed verbatim, because their
 * position does not advance.
 *
 * `rev` AND `actorId` DO NOT CHANGE, and both of those matter. The rev is how
 * this peer recognises its own echo, and bumping it would turn a retry into a
 * new write that other peers feel obliged to answer.
 *
 * That leaves something that looks like a hole and is not, so do not close it:
 * a peer that already applied the original will IGNORE this corrected resend,
 * because equal rev and equal actor is not a win in `remoteStateWins`. That is
 * right. That peer stamped its own arrival time for the original and is already
 * measuring from it, so it needs no correction. The resend exists for peers who
 * never received the original at all, and they will stamp this one on arrival
 * and get the right answer.
 *
 * `localPositionMs` is the live position, from the caller, because this module
 * has no player to ask. Pass null when there is no player to ask either (nobody
 * has joined yet, or it has failed), and the position is advanced by this
 * machine's own clock instead: `atMs` on a write we authored ourselves is our
 * own clock on both sides of the subtraction, which is the one place in this
 * file where subtracting it is not the bug the contract warns about.
 */
export function resendUnconfirmed(
  session: WatchPartySession,
  now: number,
  localPositionMs: number | null,
): WatchPartyEffects | null {
  const pending = session.pending;
  const due = nextResendAt(session);
  if (pending === null || due === null || now < due) return null;

  const at = Math.max(0, Math.round(now));
  const previous = pending.state;
  const state: WatchPartyState | null =
    previous === null || previous.status !== "playing"
      ? previous
      : {
          ...previous,
          positionMs: Math.max(
            0,
            Math.round(
              localPositionMs ??
                previous.positionMs + Math.max(0, now - previous.atMs),
            ),
          ),
          atMs: at,
        };

  return {
    session: {
      ...session,
      pending: { state, sentAt: at, attempts: pending.attempts + 1 },
    },
    broadcast: encodeSetWatchParty(state),
    commands: [],
  };
}

/**
 * Wrap a state as the client-to-server frame.
 *
 * Exported for one legitimate case beyond the calls above: re-announcing after
 * a socket reconnect, where the room has forgotten us. Reach for it anywhere
 * else and you are probably about to rebroadcast something you received.
 *
 * It throws on a state the schema rejects. The only way to get one is a caller
 * bug (an empty `actorId`, a videoId longer than the wire allows), and the
 * alternative to throwing is a frame the server drops in silence while this
 * peer believes it is in control.
 */
export function encodeSetWatchParty(
  state: WatchPartyState | null,
): SetWatchPartyMessage {
  const message = { type: "set-watch-party" as const, state };
  const parsed = setWatchPartyMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new Error(
      `refusing to send an invalid watch-party state: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Reading a pasted link                                                       */
/* -------------------------------------------------------------------------- */

/**
 * WHAT A PASTED LINK MEANS, decided by reading the link and nothing else.
 *
 * No network call and no API key, ever. This repo is public and the YouTube
 * terms do not allow shipping a credential in it, so anything that cannot be
 * answered by string work is not answered: no title, no thumbnail, no duration.
 *
 * Unrecognised means rejected, never guessed. Handing an eleven character
 * fragment of some other site's URL to the player produces a broken embed with
 * no explanation, whereas a rejection is a sentence the UI can show.
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Paths that carry the id as the segment after the marker. `watch` is not here
 * because it carries the id in the query instead.
 */
const ID_IN_PATH = new Set(["shorts", "embed", "live", "v"]);

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `1h2m3s`, and every subset of it. */
const CLOCK_OFFSET = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

export interface ParsedYouTubeLink {
  videoId: string;
  /** What the link asked to start at, in ms, matching `positionMs`. Zero when it asked for nothing. */
  startMs: number;
}

export function parseYouTubeUrl(input: string): ParsedYouTubeLink | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    // People paste `youtu.be/ID` without a scheme constantly. Anything carrying
    // a scheme is left as it is and rejected below if it is not http.
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isYouTubeHost(url.hostname)) return null;

  const videoId = videoIdFrom(url);
  if (videoId === null || !VIDEO_ID.test(videoId)) return null;
  return { videoId, startMs: startOffsetMs(url) };
}

/**
 * Suffix matching on a dot boundary, not `includes`. `youtube.com.example.net`
 * is somebody else's host and reads as ours to a careless check.
 */
function isYouTubeHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === "youtu.be") return true;
  for (const root of ["youtube.com", "youtube-nocookie.com"]) {
    if (host === root || host.endsWith(`.${root}`)) return true;
  }
  return false;
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function videoIdFrom(url: URL): string | null {
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  // A youtu.be link is nothing but the id.
  if (bareHost(url.hostname) === "youtu.be") return segments[0] ?? null;
  if (segments.length >= 2 && ID_IN_PATH.has(segments[0])) return segments[1];
  // `?list=` rides along on plenty of watch links. v1 plays the video and
  // ignores the playlist, which is why the param is read and nothing else is.
  if (segments[0] === "watch") return url.searchParams.get("v");
  return null;
}

/**
 * `t` is what a share link and a youtu.be link carry, `start` is what an embed
 * carries. A timestamp we cannot read costs the offset, never the link: landing
 * at zero on a video somebody wanted to share is a small annoyance, and
 * refusing the link over it is a large one.
 */
function startOffsetMs(url: URL): number {
  for (const key of ["t", "start"]) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    const seconds = parseTimestampSeconds(raw);
    if (seconds !== null) return seconds * 1_000;
  }
  return 0;
}

/** Seconds from `90`, `90s` or `1h2m3s`. Null when it is none of those. */
export function parseTimestampSeconds(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return safeSeconds(Number(value));

  const match = CLOCK_OFFSET.exec(value);
  // Every group is optional, so the pattern also matches the empty string and
  // any all-absent variation of it.
  if (match === null || match.slice(1).every((group) => group === undefined)) {
    return null;
  }
  return safeSeconds(
    Number(match[1] ?? 0) * 3_600 +
      Number(match[2] ?? 0) * 60 +
      Number(match[3] ?? 0),
  );
}

function safeSeconds(seconds: number): number | null {
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * What the watch-party panel shows, as pure functions over the room state.
 *
 * NOTHING IN THIS MODULE SYNCHRONISES ANYTHING. It never compares a `rev`,
 * never decides a winner, never corrects drift and never parses a URL. Those
 * are `lib/watch-party/state.ts`, and the panel reaches them through injected
 * callbacks. What lives here is the other half of the feature: given the state
 * somebody else decided, which affordance does this person get.
 *
 * It is a separate file from the components because it is the part with
 * branches, and branches are the part worth pinning in a test. React rendering
 * is not.
 */

import type { WatchPartyState } from "@pqp/shared";
import type { MessageKey } from "@/lib/i18n";
import type { PlaybackFailureReason } from "@/lib/watch-party/player";

/**
 * The failure vocabulary is `lib/watch-party/player.ts`'s, not ours.
 *
 * It owns the mapping from YouTube's `onError` codes, so it owns the names
 * too. Re-exported here only so the components can name the type without
 * every one of them reaching across the module boundary for it.
 *
 * ALWAYS PER PERSON. A watch party is N independent YouTube players reading
 * one shared clock, so one of them refusing is one person's problem: the
 * shared state knows nothing about it, nothing is dispatched when it happens,
 * and everybody else carries on. That is also why the failure card says so out
 * loud, and why `transportAvailability` takes the controls away from whoever
 * it happened to.
 *
 * There is no `unknown` arm and there does not need to be: `describeYouTubeError`
 * funnels every code it has no sentence for into `playerFailed`, and the raw
 * number rides along on `PlayerFailure.code` for the small print. An unrecognised
 * code therefore still gets a sentence, which is what `docs/WATCH_PARTY.md`
 * asks for, without a second catch-all that says the same thing.
 */
export type { PlaybackFailureReason } from "@/lib/watch-party/player";

export type WatchPartyViewKind =
  | "launcher"
  | "compose"
  | "join"
  | "watching"
  | "failed";

export interface WatchPartyView {
  kind: WatchPartyViewKind;
  reason: PlaybackFailureReason | null;
}

export interface WatchPartyViewInput {
  /** The room's shared state, or null when there is no party. */
  party: WatchPartyState | null;
  /** This person has clicked the join gesture. Local, never shared. */
  joined: boolean;
  /** This person's player failed. Local, never shared. */
  failure: PlaybackFailureReason | null;
  /** The paste form has been asked for. */
  composing: boolean;
}

/**
 * The single branch that decides the panel.
 *
 * Order is the whole content of this function:
 *
 * 1. No party at all is a one-line invitation, not a card. A voice channel is
 *    mostly used without a watch party, and a large empty poster above the
 *    transcript every time would be a tax on the common case.
 * 2. A party with no video is the paste form, whether or not it was asked for.
 * 3. A failure outranks the join gesture. Inviting somebody to click into a
 *    video we already know refuses to play is the one ordering that makes the
 *    product look broken.
 * 4. No gesture yet is the join card, and CRUCIALLY not the player: see
 *    `showsPlayer`.
 */
export function watchPartyView(input: WatchPartyViewInput): WatchPartyView {
  const { party, joined, failure, composing } = input;
  if (party === null) {
    return { kind: composing ? "compose" : "launcher", reason: null };
  }
  if (party.videoId === null) {
    return { kind: "compose", reason: null };
  }
  if (failure !== null) {
    return { kind: "failed", reason: failure };
  }
  if (!joined) {
    return { kind: "join", reason: null };
  }
  return { kind: "watching", reason: null };
}

/**
 * The join gate, stated as one function so a test can hold it.
 *
 * The player is mounted in exactly one view. Not mounted-and-hidden, not
 * mounted-behind-a-scrim: the IFrame API terms forbid covering the player's
 * own chrome, and a muted player parked under an invitation is that same idea
 * wearing a hat. Until somebody clicks, there is no iframe, no request to
 * Google, and nothing for autoplay policy to refuse.
 */
export function showsPlayer(view: WatchPartyView): boolean {
  return view.kind === "watching";
}

/**
 * The paste form is a strip, not a mode: while a video is playing, "trocar
 * vídeo" opens it *below* the player rather than replacing it, because
 * unmounting the player would drop this person out of the party in order to
 * type a link.
 */
export function showsComposer(view: WatchPartyView, composing: boolean): boolean {
  return view.kind === "compose" || composing;
}

/**
 * Play, pause and skip: available, present but visibly out of reach, or gone.
 *
 * THIS IS THE UI HALF OF A CORRECTNESS RULE, NOT A TIDINESS PREFERENCE.
 * `packages/shared/src/watch-party.ts` states it as "who may write": a
 * participant whose player has failed is a reader of this state and never a
 * writer, and the client has to enforce that on itself. A failed player
 * reports position 0 for ever, and position 0 on a fresh `rev` outranks
 * everybody and drags the whole room back to the start of the video.
 *
 * WHY `unavailable` RATHER THAN JUST HIDING THEM. Controls that vanish read as
 * a screen that broke. Controls that are there and plainly out of reach, with
 * a line saying why, read as a rule: you are still in this party, you are just
 * not the one driving it. That is the true description of the situation, and
 * it is the difference between somebody rejoining the channel and somebody
 * reloading the app. It follows the house pattern the voice panel already uses
 * for a screen-share button the platform cannot honour: dimmed and explained,
 * never a silent absence.
 */
export type TransportAvailability = "on" | "unavailable" | "off";

export function transportAvailability(
  view: WatchPartyView,
): TransportAvailability {
  if (view.kind === "watching") {
    return "on";
  }
  if (view.kind === "failed") {
    return "unavailable";
  }
  // Nobody who has not clicked in gets a remote control they never picked up.
  return "off";
}

/**
 * Whether "trocar vídeo" and "encerrar" are offered.
 *
 * DELIBERATELY WIDER THAN `transportAvailability`, AND HERE IS THE ARGUMENT.
 * The write ban is about a dead player *reporting* playback: a sampled
 * position of 0 that the person never chose and cannot see. Neither of these
 * two carries a sampled position. Loading a video states its own position
 * explicitly, and ending the party is `state: null`, which has no `rev` and no
 * position to lose a race with. Neither can be produced by a broken player on
 * its own; both need a link typed or a button pressed.
 *
 * Without this, the person who pasted a link that turns out to be
 * embedding-disabled is the one person in the channel who cannot replace it,
 * which is exactly backwards. The recovery for half the failure reasons is
 * "watch something else", and somebody has to be able to say so.
 */
export function showsPartyEditing(view: WatchPartyView): boolean {
  return view.kind === "watching" || view.kind === "failed";
}

/** The party is torn down: forget the gesture, so rejoining asks again. */
export function keepsJoined(
  joined: boolean,
  party: WatchPartyState | null,
): boolean {
  return party === null ? false : joined;
}

export interface FailurePresentation {
  title: MessageKey;
  body: MessageKey;
  /**
   * - `blocked`: the uploader or YouTube refuses third-party playback.
   * - `environment`: this machine or this deploy is wrong, the video is fine.
   * - `gone`: there is nothing at that id to play.
   * - `flaky`: the player fell over and probably will not next time.
   */
  tone: "blocked" | "environment" | "gone" | "flaky";
  /**
   * Whether "tentar de novo" is offered.
   *
   * False for every refusal that is a property of the video, because a retry
   * button there is a lie: the second attempt fails identically, and the person
   * learns to distrust the button. Those states get the YouTube link only.
   */
  retryable: boolean;
}

/**
 * ONE CARD FOR TWO CAUSES WE CANNOT TELL APART, AND SAYING SO.
 *
 * The IFrame API returns 101 and 150 for uploader-disabled embedding *and* for
 * age restriction, and 150 is documented as an alias of 101. Nothing separates
 * them without the YouTube Data API, which this repo cannot carry a key for.
 * `describeYouTubeError` therefore never returns `ageRestricted`, and it has a
 * test sweeping every code from -10 to 200 to keep it that way.
 *
 * So the copy names both possibilities instead of picking one. The reader's
 * action is identical either way, which means the uncertainty costs them
 * nothing, while confidently saying "the uploader turned embedding off" about
 * an age-restricted video is a small lie with no upside. There used to be a
 * second card here; it could never render, which is the same failure as a test
 * that cannot fail.
 */
const NOT_PLAYABLE: FailurePresentation = {
  title: "watchParty.failure.notPlayable.title",
  body: "watchParty.failure.notPlayable.body",
  tone: "blocked",
  retryable: false,
};

const FAILURE_PRESENTATION: Record<PlaybackFailureReason, FailurePresentation> = {
  notPlayable: NOT_PLAYABLE,
  /**
   * Not a second card, and not a reachable state.
   *
   * The arm is still in `player.ts`'s union, so this map has to be total; it
   * points at the *same object* rather than at a copy, which makes "we cannot
   * tell these apart" true by construction and cannot drift. A test pins the
   * identity, so re-adding distinct age-restriction copy on the strength of
   * the folklore that 150 means age restriction fails the suite rather than
   * shipping a confident wrong sentence. Delete this line once the union arm
   * goes.
   */
  ageRestricted: NOT_PLAYABLE,
  /**
   * Error 153. Singled out on purpose.
   *
   * A missing HTTP `Referer` is a property of how this page was opened, not of
   * the video, and every other failure card here reads as "pick something
   * else". Telling somebody to pick another video when the video is fine sends
   * them off to fail four more times. So this one gets its own tone, its own
   * headline saying the fault is on our side, and the retry button, which is
   * the action that actually helps.
   */
  refererBlocked: {
    title: "watchParty.failure.refererBlocked.title",
    body: "watchParty.failure.refererBlocked.body",
    tone: "environment",
    retryable: true,
  },
  videoUnavailable: {
    title: "watchParty.failure.videoUnavailable.title",
    body: "watchParty.failure.videoUnavailable.body",
    tone: "gone",
    retryable: false,
  },
  playerFailed: {
    title: "watchParty.failure.playerFailed.title",
    body: "watchParty.failure.playerFailed.body",
    tone: "flaky",
    retryable: true,
  },
};

export function failurePresentation(
  reason: PlaybackFailureReason,
): FailurePresentation {
  return FAILURE_PRESENTATION[reason];
}

/*
 * THERE IS NO LINK BUILDER HERE ANY MORE. `lib/watch-party/player.ts` exports
 * `watchOnYouTubeUrl` and stamps one onto every `PlayerFailure` it produces.
 * A second implementation of "what URL is this video at" is exactly the kind
 * of duplication that ends with two answers, so the failure card uses theirs.
 */

/**
 * What the room is doing, in one line.
 *
 * Named when we can name them: "Ana pausou" answers the question people
 * actually have when a video stops, which is not "is it paused" but "who did
 * that". Your own action stays unattributed, because "Você pausou" is a
 * sentence about something you just did on purpose.
 */
export function statusKey(
  status: WatchPartyState["status"],
  actorName: string | null | undefined,
  actorIsSelf: boolean,
): MessageKey {
  if (status === "ended") {
    return "watchParty.status.ended";
  }
  const named = Boolean(actorName) && !actorIsSelf;
  if (status === "playing") {
    return named ? "watchParty.status.playingBy" : "watchParty.status.playing";
  }
  return named ? "watchParty.status.pausedBy" : "watchParty.status.paused";
}

/** How far the skip buttons jump. Ten seconds, the same as every player. */
export const SKIP_MS = 10_000;

import { z } from "zod";
import { hasPermission, Permission } from "./permissions.js";

/**
 * A watch party as an EVENT WITH A HOST, not a channel with a flag.
 *
 * WHY THIS FILE EXISTS. What shipped on 2026-09-08 was plumbing: a
 * `watch_party` channel kind (PR 354), a `channel_sessions` row that
 * announces a time (PR 352), and an HLS egress that turns a screen share
 * into a playlist. Nothing tied them together, so nobody owned a party,
 * nothing had a name of its own, and the only way to start one was to walk
 * into a voice room and press Share. This module is the missing object: who
 * runs the party, what state it is in, and who may move it between states.
 *
 * ONE OBJECT, NOT TWO. There is no `watch_parties` table. A party IS a
 * `channel_sessions` row, extended with a host, co-hosts and options. That
 * was a deliberate choice over a second table: `channel_sessions` already
 * carries the title, the channel, the creator, the reminder subscriptions
 * and a partial unique index that allows exactly one active row per channel,
 * which is the same cardinality a party wants. A scheduled session going
 * live does not become a different row, it changes state, so "the thing you
 * were reminded about" and "the thing that is on air" have one id and one
 * history. See `docs/WATCH_PARTY.md` for the argument in full.
 *
 * THE STATE IS SERVER TRUTH AND THE PERMISSIONS ARE RE-CHECKED THERE. Every
 * predicate here is pure and is called on both sides: the client to decide
 * what to render, the server to decide what to allow. A client that computes
 * `true` for an action it may not perform gets a 403, never a party.
 */

// ---------------------------------------------------------------- the states

/**
 * DRAFT is the state that makes this a journey rather than a switch.
 *
 * A host who presses "Criar watch party" gets a party that exists, has a
 * name, has options, and is invisible to everyone else. They can name it,
 * pick a source, look at their own preview and change their mind, and none
 * of it is broadcast. `live` is entered by exactly one deliberate act, which
 * is the whole point: before "Ir ao vivo" the audience does not know the
 * party exists, and after it the channel is live for everyone who may view
 * it.
 *
 * SCHEDULED is a draft that has been announced. It has a `startsAt`, it is
 * visible to everyone who can view the channel, and it collects reminders.
 * The no-show sweep in `services/channel-sessions.ts` still ends a scheduled
 * party that never went live an hour past its time; it does NOT touch a
 * draft, because a draft was never promised to anyone.
 */
/**
 * NAMED `Phase` AND NOT `State`, ONLY BECAUSE THE NAME WAS TAKEN.
 * `packages/shared/src/watch-party.ts` already exports a `WatchPartyState`:
 * the synchronised YouTube player position that a room shares over the
 * signalling socket. Two unrelated things called "watch party" is a fact
 * about this repo, not a design; the wire field here is still `state`,
 * because that is what it is, and only the TypeScript name moved out of the
 * way.
 */
export const WATCH_PARTY_PHASES = [
  "draft",
  "scheduled",
  "live",
  "ended",
  "cancelled",
] as const;

export type WatchPartyPhase = (typeof WATCH_PARTY_PHASES)[number];

/** States in which the party is over and nothing may move it again. */
export const WATCH_PARTY_TERMINAL_PHASES: readonly WatchPartyPhase[] =
  Object.freeze(["ended", "cancelled"]);

export function isWatchPartyTerminal(state: WatchPartyPhase): boolean {
  return WATCH_PARTY_TERMINAL_PHASES.includes(state);
}

/** States in which nothing is being broadcast yet. */
export function isWatchPartyPreLive(state: WatchPartyPhase): boolean {
  return state === "draft" || state === "scheduled";
}

/**
 * THE TRANSITION TABLE, and it is the only place a legal move is written
 * down. `cancelChannelSession` and the no-show sweep both used to encode
 * their own idea of which statuses they could act on, in SQL, in two
 * different files; that is how a "cancel a live party" bug gets written
 * twice. Every mover asks here first.
 *
 * `scheduled -> ended` is the no-show: the time came and went and nobody
 * ever pressed Ir ao vivo. `draft -> ended` is deliberately NOT legal: a
 * draft nobody saw is cancelled, not ended, and the difference matters
 * because `ended` is what the sidebar and the reminders treat as "it
 * happened".
 */
const TRANSITIONS: Readonly<Record<WatchPartyPhase, readonly WatchPartyPhase[]>> =
  Object.freeze({
    draft: Object.freeze(["scheduled", "live", "cancelled"] as const),
    scheduled: Object.freeze(["draft", "live", "ended", "cancelled"] as const),
    live: Object.freeze(["ended"] as const),
    ended: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
  });

export function canTransitionWatchParty(
  from: WatchPartyPhase,
  to: WatchPartyPhase,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function watchPartyTransitionsFrom(
  from: WatchPartyPhase,
): readonly WatchPartyPhase[] {
  return TRANSITIONS[from];
}

// ----------------------------------------------------------------- the roles

/**
 * Four roles, in descending authority, and only the first two are stored.
 *
 * `host` is one person: whoever created the party, until they hand it over
 * or a co-host claims it after they drop. `cohost` is a list the host keeps.
 * `manager` is nobody in particular: it is what MANAGE_CHANNELS buys, and it
 * exists so a moderator can pull down a party that has gone wrong without
 * being handed the party. `viewer` is everyone else.
 *
 * A manager is deliberately NOT allowed to promote themselves to host by
 * accident, only to stop the party. Taking over a live room is a visible act
 * and should stay one.
 */
export const WATCH_PARTY_ROLES = ["host", "cohost", "manager", "viewer"] as const;

export type WatchPartyRole = (typeof WATCH_PARTY_ROLES)[number];

export interface WatchPartyRoleInput {
  /** The person asking. */
  userId: string;
  hostUserId: string;
  cohostUserIds: readonly string[];
  /** Their effective permissions on the party's channel. */
  permissions: bigint;
}

export function watchPartyRole(input: WatchPartyRoleInput): WatchPartyRole {
  if (input.userId === input.hostUserId) {
    return "host";
  }
  if (input.cohostUserIds.includes(input.userId)) {
    return "cohost";
  }
  if (hasPermission(input.permissions, Permission.MANAGE_CHANNELS)) {
    return "manager";
  }
  return "viewer";
}

// --------------------------------------------------------------- the actions

/**
 * Everything anyone can do to a party. Split finely on purpose: "end it" and
 * "rename it" have different answers for a manager, and one `canManage`
 * boolean would have to pick one of them and be wrong about the other.
 */
export const WATCH_PARTY_ACTIONS = [
  /** See that the party exists at all. A draft is host-side only. */
  "view",
  /** Rename, retime, change the options. */
  "edit",
  /** Publish a draft with a time so the room can see it and set reminders. */
  "schedule",
  /** The one deliberate act: start broadcasting. */
  "goLive",
  /** Stop a live party. */
  "end",
  /** Call off a party that never went live. */
  "cancel",
  "promoteCohost",
  "demoteCohost",
  "transferHost",
  /** Become host after the host dropped and the grace clock is running. */
  "claimHost",
] as const;

export type WatchPartyAction = (typeof WATCH_PARTY_ACTIONS)[number];

/**
 * WHO MAY DO WHAT, and the two rules worth arguing about are both here.
 *
 * A CO-HOST MAY RUN THE PARTY BUT NOT THE ROSTER. They can rename it, go
 * live, and end it, because a co-host exists so the show does not depend on
 * one person's laptop. They cannot promote, demote or hand over the host
 * role, because the moment they can, a co-host can demote the host and there
 * is no chain of authority left. Succession runs through `claimHost`, which
 * is gated on the host actually being gone.
 *
 * A MANAGER MAY STOP A PARTY BUT NOT START ONE. MANAGE_CHANNELS ends and
 * edits a live party (that is moderation, and the brief asks for it) and
 * cancels one that has not started. It does not press Ir ao vivo on someone
 * else's draft, and it does not see that draft in the first place. A draft
 * is a person thinking, not channel configuration.
 */
const ALLOWED: Readonly<Record<WatchPartyAction, readonly WatchPartyRole[]>> =
  Object.freeze({
    view: Object.freeze(["host", "cohost", "manager", "viewer"] as const),
    edit: Object.freeze(["host", "cohost", "manager"] as const),
    schedule: Object.freeze(["host", "cohost"] as const),
    goLive: Object.freeze(["host", "cohost"] as const),
    end: Object.freeze(["host", "cohost", "manager"] as const),
    cancel: Object.freeze(["host", "cohost", "manager"] as const),
    promoteCohost: Object.freeze(["host"] as const),
    demoteCohost: Object.freeze(["host"] as const),
    transferHost: Object.freeze(["host"] as const),
    claimHost: Object.freeze(["cohost"] as const),
  });

/** Which states each action is legal in, before roles are considered. */
const ACTION_STATES: Readonly<
  Record<WatchPartyAction, readonly WatchPartyPhase[]>
> = Object.freeze({
  view: Object.freeze([...WATCH_PARTY_PHASES]),
  edit: Object.freeze(["draft", "scheduled", "live"] as const),
  schedule: Object.freeze(["draft", "scheduled"] as const),
  goLive: Object.freeze(["draft", "scheduled"] as const),
  end: Object.freeze(["live"] as const),
  cancel: Object.freeze(["draft", "scheduled"] as const),
  promoteCohost: Object.freeze(["draft", "scheduled", "live"] as const),
  demoteCohost: Object.freeze(["draft", "scheduled", "live"] as const),
  transferHost: Object.freeze(["draft", "scheduled", "live"] as const),
  claimHost: Object.freeze(["live"] as const),
});

export interface WatchPartyPermissionInput {
  action: WatchPartyAction;
  role: WatchPartyRole;
  state: WatchPartyPhase;
  /**
   * When the host's last socket went away, or null while they are here.
   * Only `claimHost` reads it: succession is not available while the host
   * is present, however keen a co-host is.
   */
  hostDisconnectedAt?: number | null;
  /** For `claimHost`: the clock, so the grace window can be checked. */
  now?: number;
}

export function canPerformWatchPartyAction(
  input: WatchPartyPermissionInput,
): boolean {
  const { action, role, state } = input;
  if (!ACTION_STATES[action].includes(state)) {
    return false;
  }
  if (!ALLOWED[action].includes(role)) {
    return false;
  }
  if (action === "view") {
    // The one state-and-role interaction that is not a table lookup: a
    // draft belongs to the people setting it up. Everybody else finds out
    // when it goes live, which is the entire point of having a draft.
    return state !== "draft" || role === "host" || role === "cohost";
  }
  if (action === "claimHost") {
    return isWatchPartyHostGraceOpen({
      hostDisconnectedAt: input.hostDisconnectedAt ?? null,
      now: input.now ?? Date.now(),
    });
  }
  return true;
}

// ------------------------------------------------------- the host disconnect

/**
 * HOW LONG A PARTY OUTLIVES ITS HOST'S CONNECTION.
 *
 * Five minutes, and the number is a product decision rather than a technical
 * one. A host whose wifi drops or whose browser reloads is back in seconds
 * (the media session already resumes across an API restart, see PR 162), so
 * anything shorter than a minute would end parties over nothing. Anything
 * much longer leaves a room "live" with nobody running it, which is worse
 * than ending it, because the sidebar keeps promising a show.
 *
 * WHAT THIS CLOCK IS NOT. It is not the stream. The egress dies when the
 * presenter's screen share stops, which is a separate event with its own
 * recovery (`hls-egress.ts`), and a host can perfectly well drop while a
 * co-host is the one presenting. This clock is only about who is in charge.
 */
export const WATCH_PARTY_HOST_GRACE_MS = 5 * 60 * 1000;

export function isWatchPartyHostGraceOpen(input: {
  hostDisconnectedAt: number | null;
  now: number;
  graceMs?: number;
}): boolean {
  if (input.hostDisconnectedAt === null) {
    return false;
  }
  const grace = input.graceMs ?? WATCH_PARTY_HOST_GRACE_MS;
  return input.now - input.hostDisconnectedAt < grace;
}

export type WatchPartyHostOutcome =
  /** Nothing to do: the host is here, or the party is not live. */
  | "hold"
  /** The host is gone and the clock is still running. */
  | "grace"
  /** The clock ran out. End the party. */
  | "end";

/**
 * What the sweep should do about a party whose host is not connected.
 *
 * Called every minute alongside the reminder tick, and on the socket-close
 * path so a party with no co-host does not sit live for five minutes with
 * nobody able to take it. The answer does NOT depend on whether a co-host
 * exists: a party with co-hosts and a party without both stay live for the
 * grace window, because the audience is watching either way and cutting them
 * off early to make a point about ownership helps nobody. What a co-host
 * changes is whether anyone can press "Assumir" during that window.
 */
export function resolveWatchPartyHost(input: {
  state: WatchPartyPhase;
  hostDisconnectedAt: number | null;
  now: number;
  graceMs?: number;
}): WatchPartyHostOutcome {
  if (input.state !== "live") {
    return "hold";
  }
  if (input.hostDisconnectedAt === null) {
    return "hold";
  }
  return isWatchPartyHostGraceOpen(input) ? "grace" : "end";
}

// --------------------------------------------------------------- the options

/**
 * WHO MAY SPEAK, and it is the option that matters most because it is the one
 * that decides whether anybody is asked for a microphone at all.
 *
 * `hosts_only` IS THE DEFAULT, and the reason is the failure mode rather than
 * a preference: a party of two hundred people with open microphones is not a
 * watch party, it is a riot, and the 2026-09-05 spike showed how quickly a
 * room here gets to two hundred. Watching is the thing almost everyone came
 * to do, and it needs no device permission whatsoever.
 *
 * `invited` is the same closed stage plus a door: the host puts one person up
 * at a time, and only that person is ever asked for a microphone.
 *
 * `everyone` is the old behaviour, kept because a film night among six friends
 * genuinely wants it, and warned about in the copy for a large room.
 */
export const WATCH_PARTY_STAGE_MODES = [
  "hosts_only",
  "invited",
  "everyone",
] as const;

export type WatchPartyStageMode = (typeof WATCH_PARTY_STAGE_MODES)[number];

/** Whether this mode closes the stage to @everyone at the channel level. */
export function stageModeClosesTheFloor(mode: WatchPartyStageMode): boolean {
  return mode !== "everyone";
}

/**
 * The settings a host decides BEFORE an audience arrives, which is the whole
 * reason the draft state exists, and may change again while the party runs.
 *
 * SIX CONTROLS AT MOST, AND ONE OF THEM IS A SENTENCE. Who can WATCH is
 * deliberately not here: that is the channel's own permissions, and a second
 * permission system layered over them would be two places to get a private
 * party wrong. The panel says so in words instead of offering a control.
 *
 * QUALITY IS NOT HERE YET, ON PURPOSE. The HLS quality ladder is a separate
 * branch and owns what a host may choose; when it lands it adds one key here
 * (`quality`, defaulting to automatic) rather than growing a parallel control.
 * A dead dropdown that changes nothing would be worse than its absence.
 */
export const watchPartyOptionsSchema = z.object({
  /**
   * WHETHER THIS PARTY HAS VOICE AT ALL, and it is off by default.
   *
   * A watch party used to be a voice channel with an audience bolted on, and
   * almost every defect a full day of live testing found came from that. A
   * viewer was offered three primary-green ways to join a call while they
   * were watching one. Joining a `hosts_only` party landed them in "Listening
   * only. You do not have permission to speak", so the button promised what
   * it could not deliver. The audience is seatless by construction and the
   * transcode does not carry a microphone, so voice in a broadcast was only
   * ever for the handful who took a seat: watching costs a socket, a seat
   * costs a LiveKit participant and forwarded streams.
   *
   * AND THE FAILURE MODE THAT DECIDED IT. Closing the floor is implemented by
   * writing an @everyone SPEAK deny onto the channel. A party that ends
   * through a path which does not clean up leaves that rule behind, and one
   * was found on production on 2026-09-11 that would have silenced an entire
   * audience the following Saturday even with the floor set to open. It had
   * to be deleted by hand. THE DEFAULT PATH NOW WRITES NO PERMISSION RULE AT
   * ALL, so that class of leak cannot happen: not "is cleaned up correctly",
   * but "was never written". `watchPartyFloorIsClosed` is the one question
   * that decides whether anything is written, and it is false here by
   * default.
   *
   * A HOST TURNS IT ON IN ONE CONTROL. Six friends watching a film genuinely
   * want to talk over it; five hundred people watching a presentation do not.
   * The panel offers "Voz" as a single select whose first entry is off and
   * whose other three are the stage modes below, so the film night is one
   * click away and the broadcast is zero.
   *
   * LEGACY ROWS READ AS ON. A party stored before this option existed carries
   * no `voiceEnabled` key, and it was a voice room when its host set it up.
   * `withLegacyWatchPartyVoice` restores that reading before this schema is
   * applied, so a party that was already running keeps working. Every row
   * written since carries the key explicitly.
   */
  voiceEnabled: z.boolean().default(false),
  stageMode: z.enum(WATCH_PARTY_STAGE_MODES).default("hosts_only"),
  /**
   * A viewer may ask to come up. Meaningless when everyone may already speak,
   * and pointless when only the hosts ever will, so the panel shows it only
   * for `invited`, where it defaults on.
   */
  raiseHand: z.boolean().default(true),
  /**
   * Seconds between messages, 0 for off. THE CHANNEL'S OWN SLOW MODE
   * (`channels.slowmode_seconds`, enforced in `ws/chat.ts` against
   * `services/slow-mode.ts`), not a party-specific copy: the party carries the
   * value the host picked so that one press of Ir ao vivo applies it, and
   * ending the party puts the channel's old value back.
   */
  slowModeSeconds: z.number().int().min(0).max(21600).default(0),
  /** The floating live reactions. */
  reactionsEnabled: z.boolean().default(true),
});

export type WatchPartyOptions = z.infer<typeof watchPartyOptionsSchema>;

export const WATCH_PARTY_DEFAULT_OPTIONS: WatchPartyOptions = Object.freeze({
  voiceEnabled: false,
  stageMode: "hosts_only",
  raiseHand: true,
  slowModeSeconds: 0,
  reactionsEnabled: true,
});

/**
 * Whether this party is holding the channel's floor closed, which is the ONLY
 * question that may cause a permission rule to be written.
 *
 * Two conditions, and the first is the one that matters: a party with no
 * voice does not touch the channel's permissions, whatever its stage mode
 * says. A stored `stageMode` on a voice-off party is a preference the host
 * has not activated, not a rule, so it must not reach `channel_overwrites`.
 * That is what makes "the leak cannot happen" true rather than "the leak is
 * cleaned up": with voice off, `applyGoLiveOptions` writes nothing at all.
 *
 * Both sides ask this one function, so the server's writes and the client's
 * reading of them cannot disagree about when a channel is being borrowed.
 */
export function watchPartyFloorIsClosed(options: WatchPartyOptions): boolean {
  return options.voiceEnabled && stageModeClosesTheFloor(options.stageMode);
}

/**
 * Read an options object stored before `voiceEnabled` existed.
 *
 * A row written by an older build has no `voiceEnabled` key, and it was set
 * up in a world where every watch party was a voice room. Letting the schema
 * default decide would silently take voice away from a party that was already
 * running, which is the one thing this change must not do. Presence of the
 * key is the whole test: `createWatchParty` writes the full option set, so
 * every row written since carries it, including an explicit `false`.
 *
 * Anything that is not a plain object is handed back untouched:
 * `watchPartyOptionsSchema` owns rejecting it, and this must not turn junk
 * into a valid party.
 */
export function withLegacyWatchPartyVoice(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  if ("voiceEnabled" in raw) {
    return raw;
  }
  return { ...(raw as Record<string, unknown>), voiceEnabled: true };
}

/**
 * Whether a seat in this party's room is this person's to take.
 *
 * THE MODEL, IN ONE FUNCTION. A watch party has an audience and it has the
 * people running it. The audience watches, which is a socket and no seat; the
 * people running it need a seat, because the HLS egress follows whoever is
 * SHARING and a screen share needs a peer in the room. With voice off there
 * is nobody in between.
 *
 * NOT ENFORCED THROUGH PERMISSION BITS, deliberately. The obvious
 * implementation is a CONNECT deny on @everyone, and that is the same
 * mechanism as the SPEAK deny whose leak caused this change: a rule written
 * onto a channel that outlives the party which wrote it. This is a decision
 * taken at the door, on the party's own row, so it disappears when the party
 * does, by construction. The server asks it at `join-voice-room`, which is
 * the only way into a room; the client asks it to decide what to draw.
 *
 * WHO IS ALWAYS LET IN, and why each:
 *  - anyone holding START_WATCH_PARTY on the channel. They run parties here,
 *    they have to be able to get into the room to present, and this covers
 *    the host on every path without a lookup;
 *  - the host and the co-hosts by name, because a co-host is any member the
 *    host promoted and need not hold the bit;
 *  - anyone the host invited up to speak, for whom the whole point of the
 *    invitation is that they can now talk.
 *
 * NO ACTIVE PARTY IS NOT A CLOSED ROOM. A `watch_party` channel with nothing
 * running is an ordinary voice room and joins like one, which is exactly what
 * `VITE_WATCH_PARTY_CHANNELS` off already promises for a build that draws no
 * party chrome at all. Refusing there would break a deployment that has the
 * channel type and not the feature.
 */
export function mayTakeWatchPartySeat(input: {
  /** `START_WATCH_PARTY` on this channel, as the server resolved it. */
  canStartWatchParty: boolean;
  /** The channel's active party, or null when there is none. */
  party: {
    voiceEnabled: boolean;
    isHost: boolean;
    isCohost: boolean;
    isInvited: boolean;
  } | null;
}): boolean {
  if (input.canStartWatchParty) {
    return true;
  }
  if (!input.party) {
    return true;
  }
  return (
    input.party.voiceEnabled ||
    input.party.isHost ||
    input.party.isCohost ||
    input.party.isInvited
  );
}

/**
 * Whether this person may take the microphone in a party with these options,
 * given what the server already says about their SPEAK bit.
 *
 * `canSpeak` is the authority and this is not a second one: the server denies
 * SPEAK to @everyone for a closed stage and grants it back per member, so
 * `canSpeak` alone is already correct. This exists so the client can show the
 * right AFFORDANCE (a Falar button, a Pedir pra falar button, or neither)
 * without each surface re-deriving the rule.
 */
export function watchPartySpeakAffordance(input: {
  options: WatchPartyOptions;
  role: WatchPartyRole;
  /** `welcome.canSpeak` for this room, as the server resolved it. */
  canSpeak: boolean;
}): "speak" | "raiseHand" | "none" {
  if (input.role !== "host" && input.role !== "cohost") {
    // A party with no voice offers the audience nothing, whatever the
    // channel's own SPEAK bit happens to say. With no overwrite written that
    // bit is usually the everyday default and `canSpeak` is true, so asking
    // it first would put a Falar button on every viewer's screen in exactly
    // the parties that are meant to have none.
    if (!input.options.voiceEnabled) {
      return "none";
    }
  }
  if (input.canSpeak) {
    return "speak";
  }
  if (input.role === "host" || input.role === "cohost") {
    // Running the party and denied SPEAK means the grant has not arrived yet
    // (a permissions version still propagating). Offering the button is right:
    // the server refuses it if it is genuinely wrong.
    return "speak";
  }
  if (input.options.stageMode === "invited" && input.options.raiseHand) {
    return "raiseHand";
  }
  return "none";
}

// ------------------------------------------------------------- the wire shape

const nameField = z.string().trim().min(1).max(120);

export const watchPartyStagePersonSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});

/**
 * Who is up and who is asking, sent alongside the party.
 *
 * Only the people running the party are told about the hands: a queue is a
 * moderation surface, and an audience that can see who asked and was passed
 * over is a queue that makes the room worse.
 */
export const watchPartyStageSchema = z.object({
  invited: z.array(watchPartyStagePersonSchema),
  hands: z.array(watchPartyStagePersonSchema),
  /** Whether this person's own hand is up. Everyone is told their own. */
  handRaised: z.boolean(),
});

export type WatchPartyStage = z.infer<typeof watchPartyStageSchema>;

export const watchPartyCohostSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});

export type WatchPartyCohost = z.infer<typeof watchPartyCohostSchema>;

/**
 * What the API answers with. Deliberately carries the host's display name and
 * avatar inline: the sidebar's live block shows the host's face beside the
 * party's name, and it must not need a second round trip (or a member list it
 * does not have, for a viewer who just arrived) to draw it.
 */
export const watchPartySchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  serverId: z.string().uuid().nullable(),
  /** The name the host typed. Never the channel's name. */
  name: z.string(),
  description: z.string().nullable(),
  state: z.enum(WATCH_PARTY_PHASES),
  /** ISO 8601, null for a draft that was never given a time. */
  startsAt: z.string().nullable(),
  wentLiveAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  hostUserId: z.string().uuid(),
  hostDisplayName: z.string(),
  hostAvatarUrl: z.string().nullable(),
  /** Null while the host is connected; ISO 8601 while the grace clock runs. */
  hostDisconnectedAt: z.string().nullable(),
  cohosts: z.array(watchPartyCohostSchema),
  options: watchPartyOptionsSchema,
  /** The requesting user's role, resolved server side. */
  viewerRole: z.enum(WATCH_PARTY_ROLES),
  /** Who is on the stage and who is asking. Hands are host-side only. */
  stage: watchPartyStageSchema,
  /** Whether the requesting user has a reminder for this party. */
  reminding: z.boolean(),
});

export type WatchParty = z.infer<typeof watchPartySchema>;

export const createWatchPartySchema = z.object({
  name: nameField,
  description: z.string().trim().max(2000).nullable().optional(),
  /** ISO 8601. Present creates a `scheduled` party, absent creates a `draft`. */
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  options: watchPartyOptionsSchema.partial().optional(),
});

export type CreateWatchPartyInput = z.infer<typeof createWatchPartySchema>;

export const updateWatchPartySchema = z.object({
  name: nameField.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  options: watchPartyOptionsSchema.partial().optional(),
});

export type UpdateWatchPartyInput = z.infer<typeof updateWatchPartySchema>;

/**
 * The one-line summary the sidebar's live block needs, for every channel in
 * the server at once. The full party is fetched when a surface actually
 * needs the co-host list; the sidebar never does.
 */
export function watchPartyHeadline(party: WatchParty): {
  channelId: string;
  name: string;
  hostDisplayName: string;
  hostAvatarUrl: string | null;
  live: boolean;
} {
  return {
    channelId: party.channelId,
    name: party.name,
    hostDisplayName: party.hostDisplayName,
    hostAvatarUrl: party.hostAvatarUrl,
    live: party.state === "live",
  };
}

/**
 * `POST /api/watch-parties/:id/state`. The target state, and nothing else:
 * the server derives which action that is and checks it against the role and
 * transition tables, rather than trusting a verb from the client.
 */
export const watchPartyStateRequestSchema = z.object({
  state: z.enum(["scheduled", "live", "ended", "cancelled"]),
});

export type WatchPartyStateRequest = z.infer<typeof watchPartyStateRequestSchema>;

/** `POST /api/watch-parties/:id/cohosts`. */
export const watchPartyCohostRequestSchema = z.object({
  userId: z.string().uuid(),
  /** True promotes, false demotes. */
  cohost: z.boolean(),
});

export type WatchPartyCohostRequest = z.infer<
  typeof watchPartyCohostRequestSchema
>;

/**
 * `POST /api/watch-parties/:id/host`. Either the host names a successor, or a
 * co-host claims a party whose host has dropped. `claim` and `userId` are
 * mutually exclusive in practice; the route authorises them differently.
 */
export const watchPartyHostRequestSchema = z.object({
  userId: z.string().uuid().optional(),
  claim: z.boolean().optional(),
});

export type WatchPartyHostRequest = z.infer<typeof watchPartyHostRequestSchema>;

// ------------------------------------------------------------- the surfaces

/**
 * WHICH ONE THING A WATCH PARTY CHANNEL SHOWS.
 *
 * This function exists because of a bug Rafael photographed: the channel
 * rendered "Nenhuma watch party rolando aqui" with a Criar watch party button,
 * and DIRECTLY UNDERNEATH IT the live stage, playing, with the party's name
 * and "2 na chamada". Two surfaces mounted at once, each confidently telling
 * the room something the other contradicted.
 *
 * THE CAUSE WAS TWO SOURCES OF TRUTH, not a rendering mistake. The empty state
 * asked the party object ("is there a `channel_sessions` row?") and the stage
 * asked the room ("is there a stream?"). Those disagree all the time and both
 * answers are correct:
 *
 *  - somebody joined the call and pressed Share without ever creating a party,
 *    which is the pre-existing way this worked and still works;
 *  - a party ended while the presenter kept sharing;
 *  - a draft is invisible to a viewer, so `party` is null for them while the
 *    channel is unmistakably live.
 *
 * So neither one gets to decide alone. This function is the decision, it is
 * pure, both the empty state and the live surface are derived from its single
 * answer, and `watch-party-session.test.ts` walks the whole cross product so
 * that no combination of inputs can ever produce two surfaces again.
 */
export const WATCH_PARTY_SURFACES = [
  /** Nothing to draw. Someone else's surface owns this space. */
  "none",
  /** No party, nothing live, and this person could start one. */
  "empty",
  /** A draft, being set up by the person looking at it. */
  "setup",
  /** Announced, not started. */
  "scheduled",
  /** A party, on air. */
  "live",
  /**
   * The channel is live with no party object: a bare screen share, or a party
   * this person may not see. It gets the live surface, named after the
   * channel rather than a party, and NEVER the create button.
   */
  "liveUntitled",
] as const;

export type WatchPartySurface = (typeof WATCH_PARTY_SURFACES)[number];

export function watchPartySurface(input: {
  /** The party as this person may see it, or null. */
  state: WatchPartyPhase | null;
  /** A playable stream exists for this channel. */
  hasStream: boolean;
  /** This person holds a seat in this channel's voice room. */
  inCall: boolean;
  /** This person may start a party here (START_WATCH_PARTY). */
  canStart: boolean;
}): WatchPartySurface {
  // In the call, the call stage owns the space. The party bar is drawn by the
  // live surfaces below only when this person is NOT in it; otherwise two
  // components fight over the same pixels, which is this bug's other half.
  if (input.state === "live") {
    return "live";
  }
  if (input.state === "draft") {
    return "setup";
  }
  if (input.state === "scheduled") {
    // A stream on a channel whose party has not started is still a channel
    // that is live. Drawing a countdown over a moving picture is the same
    // contradiction wearing a different hat.
    return input.hasStream ? "live" : "scheduled";
  }
  // No party this person can see.
  if (input.hasStream) {
    return "liveUntitled";
  }
  if (input.inCall) {
    // A quiet room they are sitting in. The call stage is already there and
    // an invitation to create a party on top of it is noise.
    return "none";
  }
  return input.canStart ? "empty" : "none";
}

/** Whether this surface is one of the two that mean "something is on air". */
export function isLiveWatchPartySurface(surface: WatchPartySurface): boolean {
  return surface === "live" || surface === "liveUntitled";
}

/**
 * `POST /api/watch-parties/:id/stage`. The host puts somebody up, or takes
 * them down. `raise` is the viewer's own hand, which is why it needs no
 * `userId`: nobody raises a hand on anyone else's behalf.
 */
export const watchPartyStageRequestSchema = z.union([
  z.object({
    action: z.enum(["invite", "remove"]),
    userId: z.string().uuid(),
  }),
  z.object({
    action: z.enum(["raise", "lower"]),
  }),
]);

export type WatchPartyStageRequest = z.infer<typeof watchPartyStageRequestSchema>;


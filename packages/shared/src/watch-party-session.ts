import { z } from "zod";
import { hasPermission, Permission } from "./permissions.js";

/**
 * A watch party as an EVENT WITH A HOST, not a channel with a flag.
 *
 * WHY THIS FILE EXISTS. What shipped on 2026-09-08 was plumbing: a
 * `watch_party` channel kind (PR #354), a `channel_sessions` row that
 * announces a time (PR #352), and an HLS egress that turns a screen share
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
 * (the media session already resumes across an API restart, see #162), so
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
 * The settings a host wants decided BEFORE an audience arrives, which is the
 * whole reason the draft state exists. Slow mode is a general chat feature
 * owned elsewhere (`channels.slow_mode_seconds`); this only carries the
 * value the host chose in the setup sheet so one "Ir ao vivo" can apply it,
 * rather than making them go to channel settings first.
 */
export const watchPartyOptionsSchema = z.object({
  /** Seconds between messages, 0 for off. Applied to the channel on go-live. */
  slowModeSeconds: z.number().int().min(0).max(21600).default(0),
  /** Whether the floating live reactions are on for this party. */
  reactionsEnabled: z.boolean().default(true),
  /**
   * Who may talk on the stage.
   *
   * `open` leaves the channel's own SPEAK rules alone, which is what a small
   * server watching a film together wants. `hosts_only` is the stage model:
   * the host and co-hosts talk, everyone else watches, and the channel gets
   * a SPEAK denial for @everyone while the party is live. It is undone when
   * the party ends, so a watch party does not silently reconfigure a channel
   * forever.
   */
  stageMode: z.enum(["open", "hosts_only"]).default("open"),
});

export type WatchPartyOptions = z.infer<typeof watchPartyOptionsSchema>;

export const WATCH_PARTY_DEFAULT_OPTIONS: WatchPartyOptions = Object.freeze({
  slowModeSeconds: 0,
  reactionsEnabled: true,
  stageMode: "open",
});

// ------------------------------------------------------------- the wire shape

const nameField = z.string().trim().min(1).max(120);

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

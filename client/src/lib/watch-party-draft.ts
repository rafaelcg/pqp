import type { Channel, CreateWatchPartyInput, WatchParty } from "@pqp/shared";
import { ApiError } from "./api";

/**
 * THE DRAFT LIFECYCLE, CLIENT SIDE: create it once, find it again, throw it
 * away when it was abandoned.
 *
 * WHY THIS FILE EXISTS. On 2026-09-18 one channel collected six
 * `channel_sessions` rows in seventy minutes and two of them were drafts that
 * never moved. A draft is visible only to its host and the create endpoint
 * answers 409 to EVERYBODY while one is open, so an abandoned draft is a
 * server-wide lock that nobody can see: the next person who presses "Criar
 * watch party" is told, in a raw server sentence, that a party is being set up
 * that they cannot find, cannot open and cannot end. Rafael's words were "no
 * one booked a party" and "F5ing breaks it".
 *
 * Three client-side causes, one per exported function here.
 *
 * 1. THE CLIENT ASKED FOR A SECOND PARTY IT ALREADY HAD. `handleCreateWatchParty`
 *    posted unconditionally. A host who reloaded, or who opened the dialog
 *    from a second tab, or who pressed the button twice because the first
 *    click looked like it did nothing, sent a second POST for a party this
 *    client was already holding. `startWatchParty` looks in the store first
 *    and never posts when the answer is already there.
 *
 * 2. A 409 WAS A DEAD END. Nothing caught it, so the dialog printed the
 *    server's sentence and left the host with no way forward. A 409 means
 *    "there is one already", which for the host of that one is not an error at
 *    all: it is the party they were asking for. `startWatchParty` re-reads the
 *    server's list on a 409 and attaches to their own party if it is theirs,
 *    and only says something human when it genuinely belongs to somebody else.
 *
 * 3. WALKING AWAY LEFT IT BEHIND. Nothing ever cancelled a draft that was
 *    created and then abandoned, so the lock outlived the intent by hours.
 *    `abandonWatchPartyDraft` cancels it.
 *
 * WHY THERE IS NO `pagehide` BEACON, and this is a deliberate refusal rather
 * than an omission. The obvious fix for "the tab died" is the one
 * `voice-leave-beacon.ts` uses: a keepalive POST on `pagehide`. It is wrong
 * here, because `pagehide` cannot tell a reload from a close. F5 is the single
 * most common thing a host does to a stuck party (it is literally Rafael's
 * repro), and an unload-cancel would cancel the party the host is in the
 * middle of setting up on exactly the keystroke they press to recover it,
 * turning the bug into data loss. The tab that dies and never comes back is
 * real, and it belongs to the server: a draft with no host socket and no
 * transition is a sweep's job, not a dying document's. Idempotent end/cancel
 * and the stale-draft sweep are tracked server side.
 */

/** Pre-live states a host may be brought back to instead of creating a second party. */
function isResumable(party: WatchParty): boolean {
  return party.state === "draft" || party.state === "scheduled";
}

/**
 * Whoever may take a pending party the rest of the way. The same pair the
 * sidebar's pending card already uses: a co-host may go live, so a co-host
 * pressing "Criar" wants the party that exists, not a second one.
 */
function runsIt(party: WatchParty): boolean {
  return party.viewerRole === "host" || party.viewerRole === "cohost";
}

/**
 * The party this person should be taken back to rather than given a new one.
 *
 * `serverId` narrows it because the control is per server and the store holds
 * live parties from other servers for the rail's dot.
 */
export function findResumableWatchParty(
  parties: Iterable<WatchParty>,
  serverId: string | null,
): WatchParty | null {
  for (const party of parties) {
    if (party.serverId === serverId && isResumable(party) && runsIt(party)) {
      return party;
    }
  }
  return null;
}

export type StartWatchPartyResult =
  | { kind: "created"; party: WatchParty | null; channel: Channel }
  /** The host already had one. Nothing was posted; open this instead. */
  | { kind: "attached"; party: WatchParty };

/**
 * What the server names in a 409 body: the party that is in the way. Only the
 * three fields it sends, narrowed off `ApiError.details` rather than trusted,
 * because this is a wire shape and a stale API answers without it.
 */
export interface BlockingWatchParty {
  sessionId: string;
  state: string;
  name: string;
}

export function blockingPartyFrom(error: unknown): BlockingWatchParty | null {
  if (!(error instanceof ApiError) || typeof error.details !== "object") {
    return null;
  }
  const blocking = (error.details as { blockingParty?: unknown })
    ?.blockingParty;
  if (!blocking || typeof blocking !== "object") {
    return null;
  }
  const { sessionId, state, name } = blocking as Record<string, unknown>;
  if (
    typeof sessionId !== "string" ||
    typeof state !== "string" ||
    typeof name !== "string"
  ) {
    return null;
  }
  return { sessionId, state, name };
}

export interface StartWatchPartyDeps {
  serverId: string | null;
  /** What this client already believes about the open server's parties. */
  known: Iterable<WatchParty>;
  create: (
    serverId: string,
    input: CreateWatchPartyInput,
  ) => Promise<{ party: WatchParty | null; channel: Channel }>;
  /**
   * The server's own answer, for recovering a 409. Only parties this viewer
   * may SEE come back, which is exactly the test that matters: somebody
   * else's draft is invisible and correctly reads as "not mine".
   */
  reload: (serverId: string) => Promise<WatchParty[]>;
  /** Shown when the 409 was somebody else's party. Already translated. */
  busyMessage: string;
  /**
   * The same thing with the blocking party's name in it, when the server told
   * us what it is. Naming it is the difference between "something is in the
   * way" and a person knowing which show to go and close.
   */
  busyNamedMessage?: (name: string) => string;
}

/**
 * Press "Criar watch party" and end up on a party, having posted at most once.
 *
 * Order matters: the store is checked BEFORE the network, so the common repeat
 * (a second click, a reload, a second tab) costs no request at all and cannot
 * race a draft into existence beside the one it was about to find.
 */
export async function startWatchParty(
  input: CreateWatchPartyInput,
  deps: StartWatchPartyDeps,
): Promise<StartWatchPartyResult> {
  const { serverId } = deps;
  if (!serverId) {
    throw new Error("No server selected");
  }
  const mine = findResumableWatchParty(deps.known, serverId);
  if (mine) {
    return { kind: "attached", party: mine };
  }
  try {
    const answer = await deps.create(serverId, input);
    return { kind: "created", party: answer.party, channel: answer.channel };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) {
      throw error;
    }
    // "There is one already" is only an error when it is not yours. Ask the
    // server who it belongs to rather than trusting a store that was, by
    // definition, out of date a moment ago. The reload is the authority on
    // whether it is the caller's: `blockingParty` names the party but says
    // nothing about the caller's role in it, and a draft that is not theirs
    // does not come back from that list at all.
    const parties = await deps.reload(serverId);
    const blocking = blockingPartyFrom(error);
    if (blocking) {
      for (const party of parties) {
        if (party.id === blocking.sessionId && runsIt(party)) {
          return { kind: "attached", party };
        }
      }
    }
    const fresh = findResumableWatchParty(parties, serverId);
    if (fresh) {
      return { kind: "attached", party: fresh };
    }
    throw new ApiError(
      409,
      blocking && deps.busyNamedMessage
        ? deps.busyNamedMessage(blocking.name)
        : deps.busyMessage,
    );
  }
}

/**
 * Is this a draft this client should throw away when its host walks off?
 *
 * Four conditions and every one of them is load bearing.
 *
 * `draft` ONLY. A `scheduled` party was announced to the room and people set
 * reminders for it; silently cancelling one because its host clicked a text
 * channel would be worse than the bug this file fixes.
 *
 * HOST ONLY. A co-host may run a party but may not call it off, which is the
 * shared state machine's rule (`canPerformWatchPartyAction`), not ours.
 *
 * NEVER WENT LIVE. Belt and braces against a state the store has not caught up
 * with yet; `draft` should already imply it.
 *
 * CREATED IN THIS TAB, THIS SESSION. The narrowest condition and the one that
 * keeps requirement 3 (F5 re-attaches) and requirement 2 (abandon cancels)
 * from cancelling each other out. A draft this tab made and then walked away
 * from is abandonment. A draft this tab ADOPTED — the one the host reloaded
 * into, or came back to from the sidebar's pending card — is the host
 * deliberately holding a party open, and clicking through the server while it
 * waits is the normal thing to do with one.
 */
export function shouldAbandonWatchPartyDraft(
  party: WatchParty | null,
  opts: { createdThisSession: boolean },
): boolean {
  if (!party || !opts.createdThisSession) {
    return false;
  }
  return (
    party.state === "draft" &&
    party.viewerRole === "host" &&
    party.wentLiveAt === null
  );
}

export interface AbandonWatchPartyDeps {
  cancel: (partyId: string) => Promise<unknown>;
  /** Drop it from the local store whatever the server said. */
  forget: (channelId: string) => void;
}

/**
 * Cancel an abandoned draft and forget it locally.
 *
 * SWALLOWS THE FAILURE ON PURPOSE. Every way this can fail (404 because a
 * sweep got there first, 409 because it moved, 403 because the host was
 * demoted, offline) has the same right answer: stop showing it here. A toast
 * about a party the person has already walked away from is noise, and throwing
 * out of an unmount handler is how a React error boundary eats the app.
 * Returns whether the server actually took the cancel, for tests and for the
 * caller that wants to know.
 */
export async function abandonWatchPartyDraft(
  party: WatchParty,
  deps: AbandonWatchPartyDeps,
): Promise<boolean> {
  let cancelled = false;
  try {
    await deps.cancel(party.id);
    cancelled = true;
  } catch {
    cancelled = false;
  }
  deps.forget(party.channelId);
  return cancelled;
}

/**
 * What the abandon watcher in `App.tsx` should do on this render.
 *
 * Pulled out whole rather than left inside the effect, because the bug it
 * guards against is a SEQUENCE (create, render before the channel is
 * selected, render on the setup surface, render somewhere else) and an
 * `useEffect` body cannot be driven through a sequence in a test. Four
 * answers, and the only one that costs a request is the last:
 *
 * - `forget`: it is gone or it moved on. Stop watching it.
 * - `seen`: the setup surface is on screen. Remember that, so leaving counts.
 * - `wait`: it exists but has never been on screen — the create's own await
 *   window. Leaving now is not walking away from anything.
 * - `abandon`: it was on screen and is not any more.
 */
export type DraftAbandonDecision =
  | { action: "forget" }
  | { action: "seen" }
  | { action: "wait" }
  | { action: "abandon"; party: WatchParty };

export function decideDraftAbandon(input: {
  /** What `handleCreateWatchParty` armed, or null when this tab created nothing. */
  watched: { partyId: string; seen: boolean } | null;
  parties: Iterable<WatchParty>;
  selectedChannelId: string | null;
}): DraftAbandonDecision {
  const { watched } = input;
  if (!watched) {
    return { action: "forget" };
  }
  let draft: WatchParty | null = null;
  for (const party of input.parties) {
    if (party.id === watched.partyId) {
      draft = party;
      break;
    }
  }
  if (!shouldAbandonWatchPartyDraft(draft, { createdThisSession: true })) {
    return { action: "forget" };
  }
  const party = draft as WatchParty;
  if (input.selectedChannelId === party.channelId) {
    return { action: "seen" };
  }
  if (!watched.seen) {
    return { action: "wait" };
  }
  return { action: "abandon", party };
}

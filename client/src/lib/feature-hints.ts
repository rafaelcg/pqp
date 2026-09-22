import {
  isAutomatedBrowser,
  isHintSeen,
  rememberHint,
  shouldPersistHints,
} from "./hints";

/**
 * One-shot coachmarks for controls people miss: the composer format bar,
 * Watch party / share and Música on the call dock, Fixar on the channel
 * list, and Cmd+/ for the shortcut map.
 *
 * Persistence is `lib/hints.ts` (one store). Attached hints share a queue so
 * they cannot stack; shortcuts is a CornerCard in `CORNER_HINT_ORDER` and
 * yields while an attached hint is up.
 */

export const FEATURE_HINT_IDS = [
  "callDock",
  "watchPartyHost",
  "watchPartyViewer",
  "watchParty",
  "bringFriends",
  "music",
  "musicField",
  "composerFormat",
  "channelPin",
  "shortcuts",
] as const;

export type FeatureHintId = (typeof FEATURE_HINT_IDS)[number];

export const FEATURE_HINT_STORAGE_KEYS = {
  callDock: "pqp:feature-hint-call-dock-2026-09",
  watchPartyHost: "pqp:feature-hint-watch-party-host-2026-09",
  watchPartyViewer: "pqp:feature-hint-watch-party-viewer-2026-09",
  watchParty: "pqp:feature-hint-watch-party-2026-09",
  bringFriends: "pqp:feature-hint-bring-friends-2026-09",
  // Bumped: the card was re-aimed twice under the first key (the player
  // left the sidebar for the call dock), so everybody who saw the old
  // copy had it stamped and would never be shown the one that is true.
  music: "pqp:feature-hint-music-2026-09-2",
  musicField: "pqp:feature-hint-music-field-2026-09",
  composerFormat: "pqp:feature-hint-composer-format-2026-09",
  channelPin: "pqp:feature-hint-channel-pin-2026-09",
  shortcuts: "pqp:feature-hint-shortcuts-2026-09",
} as const;

/** Attached to a control, not the corner. First match mounts. */
export const ATTACHED_FEATURE_HINT_ORDER = [
  // The call controls moved from the top of the channel into the composer
  // (September 2026). Every in-call hint below points at a control that now
  // lives in that dock, so "the controls are here" has to win the slot
  // before any of them can make sense. Once, for everyone.
  "callDock",
  // The two watch party hints come next and are the most specific: a person
  // setting a show up, and a person who has just landed in one. Both are
  // moments, not states, so they must not queue behind the standing "share is
  // on the call bar" tip that fires for anyone in any call.
  "watchPartyHost",
  "watchPartyViewer",
  "watchParty",
  // A moment: you just started sharing and the room is still a pair.
  // After the watch-party tips so those still win if both want the slot,
  // before the standing share/music tips.
  "bringFriends",
  // The queue's field, the first time somebody opens the panel. A moment,
  // like the two watch party hints above, so it comes BEFORE the standing
  // tip that points at the tile they have just pressed.
  "musicField",
  // The music queue, on the Música tile in the call dock, the first time a
  // person who may speak is in a call with nothing on. After the share tip:
  // both fire for anyone in any call, and share is the older, less
  // discoverable control.
  "music",
  "composerFormat",
  "channelPin",
] as const;

export type AttachedFeatureHintId = (typeof ATTACHED_FEATURE_HINT_ORDER)[number];

export function isFeatureHintSeen(
  id: FeatureHintId,
  storage?: Pick<Storage, "getItem"> | null,
  persist: boolean = shouldPersistHints(),
): boolean {
  return isHintSeen(FEATURE_HINT_STORAGE_KEYS[id], storage, persist);
}

export function rememberFeatureHint(
  id: FeatureHintId,
  storage?: Pick<Storage, "setItem"> | null,
  persist: boolean = shouldPersistHints(),
): void {
  rememberHint(FEATURE_HINT_STORAGE_KEYS[id], storage, persist);
}

/**
 * SPENT FOR THIS PAGE LOAD, WHICH IS NOT THE SAME AS SEEN.
 *
 * `wanting` is built from standing conditions — connected, in a call, a
 * dock on screen — and none of them changes when somebody presses Entendi.
 * So the card that had already had its turn went on winning the slot and
 * every tip behind it waited for good. On a developer's machine, where
 * `lib/hints.ts` deliberately remembers nothing so every card can be seen
 * again, "for good" is every session: `callDock` is first in the order, so
 * the music card could never once be drawn.
 *
 * A hint is spent when it is dismissed, or when the gate that justified it
 * turns off after it was shown. `components/layout/feature-hint.tsx` is
 * what decides that; this is where the queue reads it.
 */
const spentThisLoad = new Set<FeatureHintId>();

export function spendFeatureHintForLoad(id: FeatureHintId): void {
  spentThisLoad.add(id);
}

export function isFeatureHintSpentForLoad(id: FeatureHintId): boolean {
  return spentThisLoad.has(id);
}

export function resetFeatureHintsForTests(): void {
  spentThisLoad.clear();
}

export function winningFeatureHint(
  wanting: Partial<Record<AttachedFeatureHintId, boolean>>,
): AttachedFeatureHintId | null {
  for (const id of ATTACHED_FEATURE_HINT_ORDER) {
    if (wanting[id] && !spentThisLoad.has(id)) {
      return id;
    }
  }
  return null;
}

/**
 * The first time the call dock opens for this person, in a room they are
 * connected to. Not gated on having used the old layout: a newcomer is told
 * where the controls are just the same.
 */
export function shouldOfferCallDockHint(input: {
  seen: boolean;
  automated: boolean;
  /** The collapsed call bar is docked in the composer on screen. */
  dockVisible: boolean;
  connected: boolean;
}): boolean {
  return (
    !input.seen && !input.automated && input.dockVisible && input.connected
  );
}

export function shouldOfferWatchPartyHint(input: {
  seen: boolean;
  automated: boolean;
  connected: boolean;
  canStream: boolean;
  canShare: boolean;
}): boolean {
  return (
    !input.seen &&
    !input.automated &&
    input.connected &&
    input.canStream &&
    input.canShare
  );
}

/**
 * A host on the setup surface for the first time. The one sentence they need
 * is that nothing is going out yet, which is the whole difference between
 * this feature and what it replaced.
 */
export function shouldOfferWatchPartyHostHint(input: {
  seen: boolean;
  automated: boolean;
  /** The draft setup surface is on screen and this person is running it. */
  settingUp: boolean;
}): boolean {
  return !input.seen && !input.automated && input.settingUp;
}

/**
 * A viewer watching a live party for the first time. Two facts, and both are
 * things people get wrong: they are NOT in the call, and the picture is
 * behind the chat.
 */
export function shouldOfferWatchPartyViewerHint(input: {
  seen: boolean;
  automated: boolean;
  /** A live party's picture is on screen and this person has no seat. */
  watching: boolean;
}): boolean {
  return !input.seen && !input.automated && input.watching;
}

export function shouldOfferComposerFormatHint(input: {
  seen: boolean;
  automated: boolean;
  textChannelOpen: boolean;
}): boolean {
  return !input.seen && !input.automated && input.textChannelOpen;
}

export function shouldOfferShortcutsHint(input: {
  seen: boolean;
  automated: boolean;
  hasKeyboard: boolean;
  quietReady: boolean;
  attachedHint: AttachedFeatureHintId | null;
}): boolean {
  return (
    !input.seen &&
    !input.automated &&
    input.hasKeyboard &&
    input.quietReady &&
    input.attachedHint === null
  );
}

/**
 * A presenter in a small server call. Not a DM (no server to invite to),
 * not a viewer, and not a room that already has three people.
 */
export function shouldOfferBringFriendsHint(input: {
  seen: boolean;
  automated: boolean;
  presenting: boolean;
  inServer: boolean;
  /** CREATE_INVITE on the voice server, and that server is the one open. */
  canInvite: boolean;
  roomSize: number;
}): boolean {
  return (
    !input.seen &&
    !input.automated &&
    input.presenting &&
    input.inServer &&
    input.canInvite &&
    input.roomSize > 0 &&
    input.roomSize < 3
  );
}

/**
 * A person who could put something on, in a call where nobody has.
 *
 * SPEAK is the difference between a tip and a lie: without it there is
 * nothing this person may add. A track already playing draws the bar above
 * the dock, so the card would be pointing at what they are reading; an open
 * Fila is the same argument one step further on.
 */
export function shouldOfferMusicHint(input: {
  seen: boolean;
  automated: boolean;
  connected: boolean;
  canSpeak: boolean;
  /** A track is on, so the composer bar is on screen. */
  playing: boolean;
  filaOpen: boolean;
}): boolean {
  return (
    !input.seen &&
    !input.automated &&
    input.connected &&
    input.canSpeak &&
    !input.playing &&
    !input.filaOpen
  );
}

/**
 * They have opened the queue and are looking straight at the field.
 *
 * The field says what it takes whenever it is empty, which is why this was
 * dropped from the plan once that shipped. Watching somebody use it says
 * otherwise: a line under a box is read after you have worked out that the
 * box is for you, and this card is what says so. `canAdd` because without
 * SPEAK the field is not theirs to use.
 */
export function shouldOfferMusicFieldHint(input: {
  seen: boolean;
  automated: boolean;
  filaOpen: boolean;
  canAdd: boolean;
}): boolean {
  return !input.seen && !input.automated && input.filaOpen && input.canAdd;
}

export function shouldOfferChannelPinHint(input: {
  seen: boolean;
  automated: boolean;
  serverOpen: boolean;
}): boolean {
  return !input.seen && !input.automated && input.serverOpen;
}

export function featureHintEligible(id: FeatureHintId): boolean {
  return !isAutomatedBrowser() && !isFeatureHintSeen(id);
}

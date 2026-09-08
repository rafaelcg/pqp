import {
  isAutomatedBrowser,
  isHintSeen,
  rememberHint,
  shouldPersistHints,
} from "./hints";

/**
 * One-shot coachmarks for controls people miss: the composer format bar,
 * Watch party / share on the call strip, Fixar on the channel list, and
 * Cmd+/ for the shortcut map.
 *
 * Persistence is `lib/hints.ts` (one store). Attached hints share a queue so
 * they cannot stack; shortcuts is a CornerCard in `CORNER_HINT_ORDER` and
 * yields while an attached hint is up.
 */

export const FEATURE_HINT_IDS = [
  "watchPartyHost",
  "watchPartyViewer",
  "watchParty",
  "composerFormat",
  "channelPin",
  "shortcuts",
] as const;

export type FeatureHintId = (typeof FEATURE_HINT_IDS)[number];

export const FEATURE_HINT_STORAGE_KEYS = {
  watchPartyHost: "pqp:feature-hint-watch-party-host-2026-09",
  watchPartyViewer: "pqp:feature-hint-watch-party-viewer-2026-09",
  watchParty: "pqp:feature-hint-watch-party-2026-09",
  composerFormat: "pqp:feature-hint-composer-format-2026-09",
  channelPin: "pqp:feature-hint-channel-pin-2026-09",
  shortcuts: "pqp:feature-hint-shortcuts-2026-09",
} as const;

/** Attached to a control, not the corner. First match mounts. */
export const ATTACHED_FEATURE_HINT_ORDER = [
  // The two watch party hints come first and are the most specific: a person
  // setting a show up, and a person who has just landed in one. Both are
  // moments, not states, so they must not queue behind the standing "share is
  // on the call bar" tip that fires for anyone in any call.
  "watchPartyHost",
  "watchPartyViewer",
  "watchParty",
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

export function winningFeatureHint(
  wanting: Partial<Record<AttachedFeatureHintId, boolean>>,
): AttachedFeatureHintId | null {
  for (const id of ATTACHED_FEATURE_HINT_ORDER) {
    if (wanting[id]) {
      return id;
    }
  }
  return null;
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

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
  "watchParty",
  "composerFormat",
  "channelPin",
  "shortcuts",
] as const;

export type FeatureHintId = (typeof FEATURE_HINT_IDS)[number];

export const FEATURE_HINT_STORAGE_KEYS = {
  watchParty: "pqp:feature-hint-watch-party-2026-09",
  composerFormat: "pqp:feature-hint-composer-format-2026-09",
  channelPin: "pqp:feature-hint-channel-pin-2026-09",
  shortcuts: "pqp:feature-hint-shortcuts-2026-09",
} as const;

/** Attached to a control, not the corner. First match mounts. */
export const ATTACHED_FEATURE_HINT_ORDER = [
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

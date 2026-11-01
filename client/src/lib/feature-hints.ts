import { useSyncExternalStore } from "react";
import { hintDietHides } from "./hint-diet";
import {
  isHintSeen,
  rememberHint,
  shouldPersistHints,
} from "./hints";

/**
 * One-shot coachmarks for the watch party host and viewer, and the voice note
 * transcription notice. The call dock, watch now, share, bring friends,
 * Música, composer format bar, Fixar and forum tips were removed on
 * 2026-11-01.
 *
 * Persistence is `lib/hints.ts` (one store). Attached hints share a queue so
 * they cannot stack.
 */

export const FEATURE_HINT_IDS = [
  "watchPartyHost",
  "watchPartyViewer",
  // Not in the attached queue: the notice is rendered by the composer itself,
  // at the moment somebody records (see `voice-note-transcription-notice.tsx`).
  "voiceNoteTranscription",
] as const;

export type FeatureHintId = (typeof FEATURE_HINT_IDS)[number];

export const FEATURE_HINT_STORAGE_KEYS = {
  watchPartyHost: "pqp:feature-hint-watch-party-host-2026-09",
  watchPartyViewer: "pqp:feature-hint-watch-party-viewer-2026-09",
  voiceNoteTranscription: "pqp:feature-hint-voice-note-transcription-2026-10",
} as const;

/** Attached to a control, not the corner. First match mounts. */
export const ATTACHED_FEATURE_HINT_ORDER = [
  // The two watch party hints: a person setting a show up, and a person who
  // has just landed in one. They say what the screen cannot (nothing goes out
  // until Ir ao vivo; watching is not being in the call). Every other coach
  // mark was removed on 2026-11-01: each pointed at a control the app shows.
  "watchPartyHost",
  "watchPartyViewer",
] as const;

export type AttachedFeatureHintId = (typeof ATTACHED_FEATURE_HINT_ORDER)[number];

export function isFeatureHintSeen(
  id: FeatureHintId,
  storage?: Pick<Storage, "getItem"> | null,
  persist: boolean = shouldPersistHints(),
): boolean {
  // The diet (`lib/hint-diet.ts`) answers "seen" for the ids it hides, in
  // every host, so a coach mark it removes never becomes eligible.
  if (hintDietHides(id)) {
    return true;
  }
  return isHintSeen(FEATURE_HINT_STORAGE_KEYS[id], storage, persist);
}

export function rememberFeatureHint(
  id: FeatureHintId,
  storage?: Pick<Storage, "setItem"> | null,
  persist: boolean = shouldPersistHints(),
): void {
  // Nothing is stored for a hint the diet hides: using the control while the
  // flag is on must not decide what the flag's rollback shows.
  if (hintDietHides(id)) {
    return;
  }
  rememberHint(FEATURE_HINT_STORAGE_KEYS[id], storage, persist);
}

/**
 * SPENT FOR THIS PAGE LOAD, WHICH IS NOT THE SAME AS SEEN.
 *
 * `wanting` is built from standing conditions and none of them changes when
 * somebody presses Entendi. So the card that had already had its turn went on
 * winning the slot and every tip behind it waited for good. On a developer's
 * machine, where `lib/hints.ts` deliberately remembers nothing so every card
 * can be seen again, "for good" is every session.
 *
 * A hint is spent when it is dismissed, or when the gate that justified it
 * turns off after it was shown. `components/layout/feature-hint.tsx` is
 * what decides that; this is where the queue reads it.
 */
const spentThisLoad = new Set<FeatureHintId>();

/**
 * AND SPENT IS A STORE, NOT A READ, FOR THE SAME REASON THE PIP IS ONE.
 *
 * The queue reads this set while it renders and the card writes to it from
 * a click handler three trees down. Nothing subscribed, so the winner was
 * recomputed only when something ELSE re-rendered App: Entendi on a card
 * emptied the slot and left it empty until an unrelated state change came
 * along, which could be a message arriving or nothing at all.
 * `lib/music-pip.ts` has the same shape and says the same thing.
 */
let spentVersion = 0;
const spentListeners = new Set<() => void>();

export function subscribeFeatureHintsSpent(listener: () => void): () => void {
  spentListeners.add(listener);
  return () => {
    spentListeners.delete(listener);
  };
}

export function featureHintsSpentVersion(): number {
  return spentVersion;
}

export function spendFeatureHintForLoad(id: FeatureHintId): void {
  if (spentThisLoad.has(id)) {
    return;
  }
  spentThisLoad.add(id);
  spentVersion += 1;
  for (const listener of spentListeners) {
    listener();
  }
}

export function isFeatureHintSpentForLoad(id: FeatureHintId): boolean {
  return spentThisLoad.has(id);
}

export function resetFeatureHintsForTests(): void {
  spentThisLoad.clear();
  spentVersion += 1;
  spentListeners.clear();
}

export function winningFeatureHint(
  wanting: Partial<Record<AttachedFeatureHintId, boolean>>,
): AttachedFeatureHintId | null {
  for (const id of ATTACHED_FEATURE_HINT_ORDER) {
    if (wanting[id] && !spentThisLoad.has(id) && !hintDietHides(id)) {
      return id;
    }
  }
  return null;
}

/**
 * Subscribe to the set above, so the component that runs the queue renders
 * again on the spot when a card is spent instead of waiting for the next
 * unrelated update. The number it returns is a version and means nothing on
 * its own; `winningFeatureHint` is still what answers the question.
 *
 * App calls this high up with its other hooks rather than beside the queue:
 * the queue is computed far down the body, past an early return, and a hook
 * there would not run on every render.
 */
export function useFeatureHintsSpent(): number {
  return useSyncExternalStore(
    subscribeFeatureHintsSpent,
    featureHintsSpentVersion,
    featureHintsSpentVersion,
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

/**
 * The one-time "your voice notes are transcribed" notice, shown while somebody
 * records. It states a fact about THIS note, so all three must hold: transcripts
 * exist where the note is going (the flag), this account allows its notes to be
 * transcribed (`mine`; someone who already turned it off has been told), and a
 * recording is under way.
 */
export function shouldOfferVoiceNoteTranscriptionNotice(input: {
  recording: boolean;
  transcriptionOn: boolean;
  mine: boolean;
}): boolean {
  return input.recording && input.transcriptionOn && input.mine;
}

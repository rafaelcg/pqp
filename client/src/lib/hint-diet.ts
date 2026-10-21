import { useSyncExternalStore } from "react";

/**
 * THE HINT DIET (`hint_diet`, global, default OFF).
 *
 * The 2026-10-20 hints audit counted 20 surfaces before a new owner sent a
 * first message (17 for an invitee). Most of them are cards that tell a
 * person something the product already shows: a What's new card that points
 * at a rail that already carries the pip, a "controls moved" card shown to
 * accounts made after the move, coach marks for the format bar and the pin.
 * With the flag on the client treats the ids below as hidden, as if they had
 * been seen, and never draws them.
 *
 * ONE LIST, CHECKED IN THE PLACES THE QUEUES READ. Not scattered conditionals:
 * `winningCornerHint` and `winningFeatureHint` skip a hidden id (so the next
 * card in line takes the slot), `isFeatureHintSeen` answers "seen" for it
 * (so a coach mark never becomes eligible), and `rememberFeatureHint` writes
 * nothing for it. NOTHING IS STORED for a hidden hint, ever, which is the
 * whole reversibility story: turning the flag off restores every card
 * exactly as it was, including for the account that used the format bar
 * while the flag was on.
 *
 * KEPT ON PURPOSE (not here): the Música tile pip (spent by use), the Voz
 * limpa NOVO dot in Settings, the QG invite, bringFriends, watchNow, the
 * forum hint, the notify offer, the mobile beta card and the first-run
 * checklist. See `docs/ONBOARDING.md` §"The diet".
 *
 * The answer arrives on `GET /api/onboarding/config` as `hintDiet` (see
 * `lib/hint-config.ts`). Anything but an explicit `true` is off, so an older
 * API, a failed ask before any answer and a localhost without the flag all
 * behave exactly as the client did before this file existed.
 */
export const HINT_DIET_IDS = [
  // Corner queue (`lib/corner-hints.ts`).
  "whatsNew",
  "cargos",
  "shortcuts",
  "voiceClean",
  "seasonalLook",
  // Attached coach marks (`lib/feature-hints.ts`).
  "callDock",
  "watchParty",
  "music",
  "musicField",
  "composerFormat",
  "channelPin",
  // Not a queue member: the owner's empty channel repeats the arrival
  // banner's "Copiar convite" a screen away from it.
  "ownerInviteButton",
] as const;

export type HintDietId = (typeof HINT_DIET_IDS)[number];

const HIDDEN: ReadonlySet<string> = new Set(HINT_DIET_IDS);

let dietOn = false;
const listeners = new Set<() => void>();

function apply(next: boolean): void {
  if (next === dietOn) {
    return;
  }
  dietOn = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Anything but an explicit `true` is off: an older API sends no field. */
export function hintDietFromConfig(answer: { hintDiet?: unknown }): boolean {
  return answer.hintDiet === true;
}

export function setHintDiet(on: boolean): void {
  apply(on);
}

export function isHintDietOn(): boolean {
  return dietOn;
}

/** Whether the diet is on AND this id is one it hides. The one question every queue asks. */
export function hintDietHides(id: string): boolean {
  return dietOn && HIDDEN.has(id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The flag as React state: App re-renders the queue when it moves. */
export function useHintDiet(): boolean {
  return useSyncExternalStore(subscribe, isHintDietOn, () => false);
}

/** Test seam. */
export function resetHintDietForTests(): void {
  dietOn = false;
  listeners.clear();
}

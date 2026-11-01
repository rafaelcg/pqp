import { useSyncExternalStore } from "react";

/**
 * THE HINT DIET (`hint_diet`, global, default OFF).
 *
 * The 2026-10-20 hints audit counted 20 surfaces before a new owner sent a
 * first message (17 for an invitee). With the flag on the client treats the
 * ids below as hidden, as if they had been seen, and never draws them. Every
 * card and coach mark the list used to name (What's new, cargos, shortcuts,
 * Voz limpa, the seasonal look, the call dock, watch party, music, the
 * composer format bar, the channel pin) was removed outright on 2026-11-01,
 * so the list is down to the one id that is not a queue member.
 *
 * ONE LIST, CHECKED IN THE PLACES THE QUEUES READ. Not scattered conditionals:
 * `winningCornerHint` and `winningFeatureHint` skip a hidden id (so the next
 * card in line takes the slot), `isFeatureHintSeen` answers "seen" for it
 * (so a coach mark never becomes eligible), and `rememberFeatureHint` writes
 * nothing for it. NOTHING IS STORED for a hidden hint, ever, which is the
 * whole reversibility story: turning the flag off restores every card
 * exactly as it was, including for the account that used the control while
 * the flag was on.
 *
 * KEPT ON PURPOSE (not here): the Música tile pip (spent by use), the Voz
 * limpa NOVO dot in Settings, the notify offer, the watch party coach marks.
 * See `docs/ONBOARDING.md` §"The diet".
 *
 * The answer arrives on `GET /api/onboarding/config` as `hintDiet` (see
 * `lib/hint-config.ts`). Anything but an explicit `true` is off, so an older
 * API, a failed ask before any answer and a localhost without the flag all
 * behave exactly as the client did before this file existed.
 */
export const HINT_DIET_IDS = [
  // Not a queue member: the owner's empty channel repeats the arrival
  // banner's "Copiar convite" a screen away from it. Every hint the diet
  // used to hide was removed outright on 2026-11-01.
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

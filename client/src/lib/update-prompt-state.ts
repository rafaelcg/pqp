import { useSyncExternalStore } from "react";

/**
 * The one place that knows a new build is waiting.
 *
 * `UpdatePrompt` is mounted in `main.tsx`, outside `App`, because a waiting
 * service worker matters on every route. The corner-hint queue and the server
 * rail live inside `App`. This module is the seam between them:
 *
 *  - `waiting` is the durable fact: a build is precached and has not been
 *    taken yet. The rail draws its "update" affordance from this, and that
 *    affordance is the WAY BACK: it survives a snooze, a call, and every
 *    onboarding card, because none of them can write to it.
 *  - `showing` is whether the corner card is on screen right now, so
 *    `winningCornerHint` can yield the corner to it.
 *  - `requestedAt` is somebody asking for the card back. The rail bumps it;
 *    the card treats it as "show, whatever you were snoozed or muted for".
 *
 * WHY THIS EXISTS RATHER THAN THE CARD OWNING ALL OF IT. On 9 Sep 2026 a user
 * reported being stranded on an old bundle: the card had gone and nothing in
 * the product could bring it back. A single Escape did it. Every corner card
 * listens for Escape on `document`, the update card registered first, so one
 * keypress aimed at an onboarding card snoozed the update instead and left the
 * onboarding card up. Twenty minutes later the card is due again, but the card
 * also hides during a call, and a watch party is hours of call. A waiting build
 * is the only prompt in the product the person cannot act on later by other
 * means, and it gates every other fix, so it now has a home that outlives its
 * own card.
 */

interface UpdateState {
  waiting: boolean;
  showing: boolean;
  requestedAt: number | null;
}

let state: UpdateState = {
  waiting: false,
  showing: false,
  requestedAt: null,
};
const listeners = new Set<() => void>();

function set(next: Partial<UpdateState>): void {
  const merged = { ...state, ...next };
  if (
    merged.waiting === state.waiting &&
    merged.showing === state.showing &&
    merged.requestedAt === state.requestedAt
  ) {
    return;
  }
  state = merged;
  for (const listener of listeners) {
    listener();
  }
}

/** The service worker has a new build precached and ready to take over. */
export function setUpdateWaiting(next: boolean): void {
  set({ waiting: next, ...(next ? {} : { requestedAt: null }) });
}

export function setUpdatePromptShowing(next: boolean): void {
  set({ showing: next });
}

/**
 * "Show me that update notice again."
 *
 * The rail calls this. It clears any snooze and overrides the in-call hush,
 * because the person just asked for it on purpose, and a card they went looking
 * for is not an interruption.
 */
export function requestUpdatePrompt(now: number = Date.now()): void {
  set({ requestedAt: now });
}

export function isUpdatePromptShowing(): boolean {
  return state.showing;
}

export function isUpdateWaiting(): boolean {
  return state.waiting;
}

export function updateRequestedAt(): number | null {
  return state.requestedAt;
}

/** Test seam. Nothing in the app resets a module singleton. */
export function resetUpdateState(): void {
  state = { waiting: false, showing: false, requestedAt: null };
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUpdatePromptShowing(): boolean {
  return useSyncExternalStore(subscribe, isUpdatePromptShowing, () => false);
}

export function useUpdateWaiting(): boolean {
  return useSyncExternalStore(subscribe, isUpdateWaiting, () => false);
}

export function useUpdateRequestedAt(): number | null {
  return useSyncExternalStore(subscribe, updateRequestedAt, () => null);
}

/**
 * Whether the corner card should be on screen.
 *
 * Pure, and the whole visibility rule in one place, because every branch here
 * is a way the card can vanish on somebody and each one has cost a user an
 * update at least once:
 *
 *  - nothing is waiting: nothing to say;
 *  - the person asked for it back (rail) AFTER the last snooze: show it, even
 *    mid-call. They went and found the button;
 *  - snoozed and the snooze has not run out: stay quiet;
 *  - in a call: stay quiet, because reloading ends their screen share and
 *    drops them out of the room. The rail affordance is still there, so this
 *    is a hush and not a disappearance;
 *  - otherwise: show it.
 */
export function shouldShowUpdateCard(input: {
  waiting: boolean;
  snoozedAt: number | null;
  requestedAt: number | null;
  inCall: boolean;
}): boolean {
  if (!input.waiting) {
    return false;
  }
  if (
    input.requestedAt !== null &&
    (input.snoozedAt === null || input.requestedAt >= input.snoozedAt)
  ) {
    return true;
  }
  if (input.snoozedAt !== null) {
    return false;
  }
  return !input.inCall;
}

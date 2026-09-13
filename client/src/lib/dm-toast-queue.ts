/**
 * Pure stack logic for the DM arrival toast (`components/dm/dm-toasts.tsx`),
 * split out so the suppression table, the coalescing rule and the pause/resume
 * timer math are unit-testable without a DOM.
 *
 * See `docs/plans/DM_NOTIFICATIONS_POLISH.md` §3 for the shape this pins.
 */

import type { ChannelKind, NotificationLevel } from "@pqp/shared";

// ------------------------------------------------------------- suppression

export interface ArrivalToastInput {
  /** Only "dm" | "group" ever toast — a server channel never does. */
  kind: ChannelKind;
  channelId: string;
  selectedChannelId: string | null;
  /** `document.visibilityState === "visible"`. */
  documentVisible: boolean;
  /** `document.hasFocus()`, tracked by focus/blur. */
  windowFocused: boolean;
  /** Resolved, most-specific-wins notification level for this conversation. */
  level: NotificationLevel;
  doNotDisturb: boolean;
  /** `html[data-immersive-stage]` is set — fullscreen watch party or call stage. */
  immersive: boolean;
}

/**
 * Pure: whether this activity earns an in-app card.
 *
 * `documentVisible && windowFocused` is the toast's exclusive territory —
 * everything outside it belongs to the OS banner (§4). A visible-but-unfocused
 * window is the case `notifications.ts`'s old `wantsActivityToast` got wrong:
 * it checked only `documentVisible`, so a background window with a tab still
 * showing got both a toast and an OS notification for the same message.
 */
export function shouldShowArrivalToast(input: ArrivalToastInput): boolean {
  if (input.kind !== "dm" && input.kind !== "group") {
    return false;
  }
  if (input.level === "none") {
    return false;
  }
  if (input.doNotDisturb) {
    return false;
  }
  if (input.immersive) {
    return false;
  }
  if (!input.documentVisible || !input.windowFocused) {
    return false;
  }
  // The conversation already on screen never notifies about itself.
  if (input.channelId === input.selectedChannelId) {
    return false;
  }
  return true;
}

// ------------------------------------------------------------------- stack

/** At most this many cards on screen; a new one past the cap drops the oldest. */
export const MAX_CARDS = 3;

/** A card's full lifetime, and what a coalesced message resets it to. */
export const TOAST_MS = 6000;

/** The floor a hover-then-leave re-arm never goes under. */
export const MIN_RESUME_MS = 1500;

/** What every card is re-armed to when the tab regains visibility. */
export const VISIBILITY_RESUME_MS = 3000;

export interface ToastCard {
  channelId: string;
  /**
   * Identifies this particular card instance, distinct from `channelId`:
   * dismissing a card and a fresh arrival for the same conversation racing
   * within the same `LEAVE_MS` window are two different instances that
   * happen to share a channel id. A removal keyed on `channelId` alone would
   * delete whichever one happened to be current when the timer fires — see
   * `removeToastCard`.
   */
  token: number;
  count: number;
  mentions: number;
  /** When this card is due to leave, or would be if it were not paused. */
  expiresAt: number;
  /**
   * Set while a pointer or focus is on the card: the countdown is held, not
   * reset, so a card the pointer brushed does not vanish under it.
   */
  pausedRemainingMs: number | null;
  leaving: boolean;
}

let tokenCounter = 0;

/** A fresh identity for a new card instance. Exported only for tests. */
export function nextToastToken(): number {
  tokenCounter += 1;
  return tokenCounter;
}

/**
 * A new arrival. Coalesces into the existing card for the same conversation —
 * preview replaced, count incremented, timer reset to the full 6000ms,
 * POSITION UNCHANGED (a card moving under a pointer about to click it is how
 * the wrong conversation gets opened). A genuinely new conversation goes to
 * the front (newest on top) and, past the cap, drops the oldest.
 *
 * A coalesce onto a card that is currently paused (the pointer or focus is
 * still on it) stays paused, just refilled to the full duration — the
 * countdown must not sneak past a card the reader is still looking at.
 */
export function upsertToastCard(
  cards: readonly ToastCard[],
  toast: { channelId: string; count: number; mentions: number },
  now: number,
): ToastCard[] {
  const existingIndex = cards.findIndex(
    (card) => card.channelId === toast.channelId && !card.leaving,
  );
  if (existingIndex !== -1) {
    const existing = cards[existingIndex]!;
    const stillPaused = existing.pausedRemainingMs !== null;
    const updated: ToastCard = {
      ...existing,
      count: existing.count + toast.count,
      mentions: existing.mentions + toast.mentions,
      expiresAt: now + TOAST_MS,
      pausedRemainingMs: stillPaused ? TOAST_MS : null,
      leaving: false,
    };
    const next = [...cards];
    next[existingIndex] = updated;
    return next;
  }

  const fresh: ToastCard = {
    channelId: toast.channelId,
    token: nextToastToken(),
    count: toast.count,
    mentions: toast.mentions,
    expiresAt: now + TOAST_MS,
    pausedRemainingMs: null,
    leaving: false,
  };
  return [fresh, ...cards].slice(0, MAX_CARDS);
}

/** Hover or focus landed on the card: hold the remaining time. */
export function pauseToastCard(
  cards: readonly ToastCard[],
  channelId: string,
  now: number,
): ToastCard[] {
  return cards.map((card) => {
    if (card.channelId !== channelId || card.pausedRemainingMs !== null) {
      return card;
    }
    return {
      ...card,
      pausedRemainingMs: Math.max(0, card.expiresAt - now),
    };
  });
}

/** Pointer or focus left: re-arm with at least `MIN_RESUME_MS` remaining. */
export function resumeToastCard(
  cards: readonly ToastCard[],
  channelId: string,
  now: number,
): ToastCard[] {
  return cards.map((card) => {
    if (card.channelId !== channelId || card.pausedRemainingMs === null) {
      return card;
    }
    return {
      ...card,
      expiresAt: now + Math.max(MIN_RESUME_MS, card.pausedRemainingMs),
      pausedRemainingMs: null,
    };
  });
}

/**
 * The tab went hidden: freeze every timer in place by converting the
 * remaining time into a pause, same mechanism as a hover. Re-freezing an
 * already-paused card (hover then also switching tabs) leaves its remaining
 * time untouched.
 */
export function freezeToastCards(
  cards: readonly ToastCard[],
  now: number,
): ToastCard[] {
  return cards.map((card) =>
    card.pausedRemainingMs !== null
      ? card
      : { ...card, pausedRemainingMs: Math.max(0, card.expiresAt - now) },
  );
}

/**
 * The tab came back: every card gets exactly `VISIBILITY_RESUME_MS`,
 * regardless of how much was left — a tab returned to after an hour is not
 * greeted by three cards from an hour ago; it shows them briefly and clears.
 */
export function thawToastCards(
  cards: readonly ToastCard[],
  now: number,
): ToastCard[] {
  return cards.map((card) => ({
    ...card,
    expiresAt: now + VISIBILITY_RESUME_MS,
    pausedRemainingMs: null,
  }));
}

/**
 * Mark a card leaving (its exit animation), for the component to unmount
 * later. Keyed on `token` when given, so a dismiss aimed at one instance can
 * never touch a different card that has since taken its channel id.
 */
export function markToastLeaving(
  cards: readonly ToastCard[],
  channelId: string,
  token?: number,
): ToastCard[] {
  return cards.map((card) =>
    card.channelId === channelId && (token === undefined || card.token === token)
      ? { ...card, leaving: true }
      : card,
  );
}

/**
 * Keyed on `token` when given. Without it, a removal timer that outlives its
 * own card (a dismiss racing a fresh arrival for the same conversation
 * within the same `LEAVE_MS` window) would delete the *replacement* instead
 * of the stale card it was actually scheduled for.
 */
export function removeToastCard(
  cards: readonly ToastCard[],
  channelId: string,
  token?: number,
): ToastCard[] {
  return cards.filter(
    (card) =>
      !(card.channelId === channelId && (token === undefined || card.token === token)),
  );
}

/** Milliseconds until the next card not currently paused is due, or null. */
export function nextToastDeadline(
  cards: readonly ToastCard[],
  now: number,
): number | null {
  let soonest: number | null = null;
  for (const card of cards) {
    if (card.leaving || card.pausedRemainingMs !== null) {
      continue;
    }
    const remaining = card.expiresAt - now;
    if (soonest === null || remaining < soonest) {
      soonest = remaining;
    }
  }
  return soonest;
}

import { useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { browserStorage } from "@/lib/arrival";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * "CHAMA TEUS AMIGOS": the newcomer who came in alone, offered a room of
 * their own and a link to send.
 *
 * WHY (2026-10-10, accounts created in the 14 days before). A brand new
 * account with no invite is placed in the QG (`DEFAULT_COMMUNITY_SLUG`) and
 * lands on its Overview. That is a room of 5,900 strangers and a support bot.
 * Of the organic accounts that never got a second human of their own (stayed
 * QG only, or made a room nobody joined), 12% came back the next day; of the
 * ones whose own room got a second member, 35% did, and invited accounts
 * (somebody brought them) 26%. Half of the QG-only accounts did nothing at all:
 * no message, no call, no friend, and 3% of those came back. Being near other
 * people you know is what the retention follows, so the strip asks for exactly
 * that: make a room, send the link.
 *
 * The QG placement also made the hub's first-run checklist lie: its "server"
 * row ticked as done the moment the QG membership existed, so the one surface
 * that offered Criar said there was nothing left to do. With the flag on that
 * row counts only rooms that are yours or private (`ownRoomCount`).
 *
 * Behind the runtime flag `newcomer_invite_moment` (global, default off),
 * answered by `GET /api/onboarding/config` as `inviteMoment`. Off, nothing on
 * screen differs from before. The rules are plain functions so a test can
 * call each one.
 */

// ------------------------------------------------------------------ config

let inviteMomentOn = false;
const listeners = new Set<() => void>();

function apply(next: boolean): void {
  if (next === inviteMomentOn) {
    return;
  }
  inviteMomentOn = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Anything but an explicit `true` is off: an older API sends no field. */
export function inviteMomentFromConfig(answer: { inviteMoment?: unknown }): boolean {
  return answer.inviteMoment === true;
}

export const fetchOnboardingConfig = () =>
  apiFetch<{ inviteMoment?: boolean }>("/api/onboarding/config");

/**
 * Asks can overlap (the first read and a focus refresh); only an answer newer
 * than the last one applied counts, so a slow stale `true` cannot undo a flip.
 */
let asked = 0;
let applied = 0;

export async function loadNewcomerInviteConfig(
  fetcher: () => Promise<{ inviteMoment?: unknown }> = fetchOnboardingConfig,
): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const next = inviteMomentFromConfig(await fetcher());
    if (mine > applied) {
      applied = mine;
      apply(next);
    }
  } catch {
    // An older API (404) or a blip: keep the last answer.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startNewcomerInviteConfig(): () => void {
  void loadNewcomerInviteConfig();
  const stop = onConfigRefresh(() => {
    void loadNewcomerInviteConfig();
  });
  return () => {
    stop();
    // The answer belongs to the account that asked.
    asked += 1;
    applied = asked;
    apply(false);
  };
}

export function isNewcomerInviteMomentOn(): boolean {
  return inviteMomentOn;
}

export function useNewcomerInviteMoment(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => inviteMomentOn,
    () => false,
  );
}

/** Test seam. */
export function setNewcomerInviteMomentForTests(on: boolean): void {
  apply(on);
}

// ------------------------------------------------------------------- rules

/**
 * How long an account is offered the strip after first-run. A week, not the
 * party's 24 hours: the day-one return is the visit this is for, and the
 * person who comes back on day two with still nobody is the same person.
 */
export const NEWCOMER_INVITE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Closed on this browser. A campaign card, so per device like the others. */
export const NEWCOMER_INVITE_STORAGE_KEY = "pqp:newcomer-invite-2026-10";

/**
 * Whether first-run finished inside the window. Same reading of
 * `preferences.onboardedAt` as `isNewcomerAccount` (`lib/party-newcomer.ts`):
 * absent, unparseable or in the future reads as not new, because a beginner's
 * strip on a regular's screen costs more than a missing one.
 */
export function isRecentNewcomer(
  onboardedAt: string | null | undefined,
  now: number = Date.now(),
  windowMs: number = NEWCOMER_INVITE_WINDOW_MS,
): boolean {
  if (!onboardedAt) {
    return false;
  }
  const at = Date.parse(onboardedAt);
  if (!Number.isFinite(at)) {
    return false;
  }
  const age = now - at;
  return age >= -60_000 && age < windowMs;
}

export interface RoomLike {
  ownerId: string;
  isCommunity?: boolean;
}

/**
 * Rooms that are the person's own or private: everything except a public
 * community they joined. A community you own counts (it is your room); one
 * you were placed in or walked into does not. The first-run row and the strip
 * both read this, so they cannot disagree about "has a room".
 */
export function ownRoomCount(servers: readonly RoomLike[], userId: string | null): number {
  return servers.filter(
    (server) => server.ownerId === userId || server.isCommunity !== true,
  ).length;
}

export interface NewcomerInviteFacts {
  /** `inviteMoment` from `/api/onboarding/config`. */
  flagOn: boolean;
  /** `isRecentNewcomer(...)`, or the session that just finished the wizard. */
  newcomer: boolean;
  /** The friends list has answered at least once. */
  friendsLoaded: boolean;
  /** Accepted friends plus requests this account sent. */
  friendCount: number;
  /** `ownRoomCount(...)`. */
  ownRooms: number;
  /** The open server is a public community (where the strip is drawn). */
  inCommunity: boolean;
  /** A live watch party is on screen: the film is the welcome. */
  partyLive: boolean;
  /** Closed on this device. */
  dismissed: boolean;
}

/**
 * The strip shows to somebody new, alone, standing in a public community.
 * An invited account is in a private room already, so `ownRooms` is not zero
 * and it never sees this: somebody brought them, which is the thing this
 * strip is trying to cause.
 */
export function newcomerInviteVisible(facts: NewcomerInviteFacts): boolean {
  return (
    facts.flagOn &&
    facts.newcomer &&
    facts.friendsLoaded &&
    facts.friendCount === 0 &&
    facts.ownRooms === 0 &&
    facts.inCommunity &&
    !facts.partyLive &&
    !facts.dismissed
  );
}

export function isNewcomerInviteDismissed(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(NEWCOMER_INVITE_STORAGE_KEY) === "1";
  } catch {
    // Unreadable storage shows it; the component still hides it for the session.
    return false;
  }
}

export function dismissNewcomerInvite(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  try {
    storage?.setItem(NEWCOMER_INVITE_STORAGE_KEY, "1");
  } catch {
    // Session-only hide lives in the caller's state.
  }
}

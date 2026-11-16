import { useEffect, useState, useSyncExternalStore } from "react";
import { isAnnounced } from "@/lib/client-version";

/**
 * The one place that knows a new build is waiting.
 *
 * `BuildWatcher`, `UpdatePrompt` and the forced screen are mounted in
 * `main.tsx`, outside `App`, because a stale bundle matters on every route. The
 * rail and the phone's "tu" tab live inside `App` and draw the quiet update
 * indicator (`components/layout/update-indicator.tsx`). This module is the seam
 * between them.
 *
 *  - `waiting` is the durable fact from the service worker: a build is
 *    precached and has not been taken yet. With `skipWaiting` on it is rare (a
 *    new worker takes over on install), and it only counts for a page that the
 *    version poll has not said otherwise about.
 *  - `build` is what `lib/version-watch.ts` learned by reading `/version.json`.
 *    It is the main signal, and it carries WHEN the build may be announced
 *    (`announceAt`, `lib/client-version.ts`): most deploys are not announced the
 *    minute they land, only once a day.
 *
 * There is no card any more, and so no snooze and no "show me again": the
 * indicator is always there while there is something to take, and it never
 * opens by itself. See `docs/PWA.md` §"Nobody stays on an old bundle".
 */

/**
 * What `lib/version-watch.ts` has learned about the deployed build, which is a
 * SECOND and independent way of knowing an update exists. The service worker
 * only reports a new build when the page navigates; this is asked on focus and
 * on a timer, so it is the one that reaches a window that never reloads.
 */
export interface BuildStaleness {
  stale: boolean;
  /**
   * The operator pushed this one (`client_force_update`, or a bundle built
   * before `CLIENT_MIN_BUILT_AT`): announced at once, and the indicator is drawn
   * with emphasis. It never blocks; only `critical` does.
   */
  forced: boolean;
  /**
   * The operator made it CRITICAL: the page reloads even in a call, and the
   * blocking screen is up (`isCriticalBuild` in `client-version.ts`).
   */
  critical?: boolean;
  /** The deployed build's id, for the loop guard and for support. */
  latestBuild: string | null;
  /** When the deployed build was announced, or built, or first seen: how long this page has been behind. */
  since: number | null;
  /** When the deployed build was built, for "published" in the popover. Null when it did not say. */
  builtAt?: number | null;
  /**
   * When this build may first be announced (`announceAtFor`). Null or absent:
   * now. A stale page that is not yet announced shows nothing and reloads
   * nothing; `isAnnounced` is the question.
   */
  announceAt?: number | null;
}

export const FRESH_BUILD: BuildStaleness = {
  stale: false,
  forced: false,
  latestBuild: null,
  since: null,
};

interface UpdateState {
  waiting: boolean;
  build: BuildStaleness;
  /**
   * The build the person's own "check again" found, if any: that build is theirs
   * to take now, gate or not. Only that one: the next deploy waits for the gate
   * again, or a check would bring back a dot on every deploy.
   */
  askedFor: string | null;
}

let state: UpdateState = {
  waiting: false,
  build: FRESH_BUILD,
  askedFor: null,
};
const listeners = new Set<() => void>();

function set(next: Partial<UpdateState>): void {
  const merged = { ...state, ...next };
  if (
    merged.waiting === state.waiting &&
    merged.build === state.build &&
    merged.askedFor === state.askedFor
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
  set({ waiting: next });
}

/**
 * Publish what the version poll found. A new object only when something moved,
 * so subscribers are not woken every twelve minutes to learn nothing changed.
 */
export function setBuildStaleness(next: BuildStaleness): void {
  const current = state.build;
  if (
    current.stale === next.stale &&
    current.forced === next.forced &&
    Boolean(current.critical) === Boolean(next.critical) &&
    current.latestBuild === next.latestBuild &&
    current.since === next.since &&
    (current.builtAt ?? null) === (next.builtAt ?? null) &&
    (current.announceAt ?? null) === (next.announceAt ?? null)
  ) {
    return;
  }
  set({ build: next });
}

/**
 * The person pressed "check again". The daily gate (`announceAtFor`) exists so
 * nobody is TOLD of every deploy; somebody who asks is answered with what is
 * there.
 */
export function setUpdateAsked(build: string | null): void {
  set({ askedFor: build });
}

function updateAskedFor(): string | null {
  return state.askedFor;
}

export function getBuildStaleness(): BuildStaleness {
  return state.build;
}

export function useBuildStaleness(): BuildStaleness {
  return useSyncExternalStore(subscribe, getBuildStaleness, () => FRESH_BUILD);
}

export function isUpdateWaiting(): boolean {
  return state.waiting;
}

/** Test seam. Nothing in the app resets a module singleton. */
export function resetUpdateState(): void {
  state = {
    waiting: false,
    build: FRESH_BUILD,
    askedFor: null,
  };
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

export function useUpdateWaiting(): boolean {
  return useSyncExternalStore(subscribe, isUpdateWaiting, () => false);
}

/**
 * Whether there is an update to OFFER right now.
 *
 * Pure, and the whole visibility rule in one place:
 *
 *  - the version poll says the page is behind AND the build is announced (the
 *    daily gate has opened, or the operator pushed it): yes;
 *  - the version poll says the page is behind but the gate is still closed: no,
 *    and not because the worker says one is waiting either, which would make
 *    the gate a way to be told a minute later than before and nothing more;
 *  - the person checked by hand and this is the build that check found: yes,
 *    gate or not;
 *  - otherwise a service worker with a waiting build, for a page the poll has
 *    not spoken about yet: yes.
 */
export function isUpdateOffered(
  input: { build: BuildStaleness; waiting: boolean; askedFor?: string | null },
  now: number,
): boolean {
  if (input.build.stale) {
    const asked =
      input.askedFor != null && input.askedFor === input.build.latestBuild;
    return asked || isAnnounced(input.build.announceAt, now);
  }
  return input.waiting;
}

/**
 * `isUpdateOffered`, kept true to the clock: it re-renders at the moment a held
 * back build becomes announced, which no state change announces by itself.
 */
export function useUpdateOffered(): boolean {
  const build = useBuildStaleness();
  const waiting = useUpdateWaiting();
  const askedFor = useSyncExternalStore(subscribe, updateAskedFor, () => null);
  const [now, setNow] = useState(() => Date.now());
  const announceAt = build.stale ? (build.announceAt ?? null) : null;
  useEffect(() => {
    setNow(Date.now());
    if (announceAt === null) {
      return;
    }
    const wait = announceAt - Date.now();
    if (wait <= 0) {
      return;
    }
    // A timer past 24 days would overflow; the poll republishes long before.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [announceAt]);
  return isUpdateOffered({ build, waiting, askedFor }, now);
}

/**
 * WHEN a page that knows it is out of date does something about it.
 *
 * One pure function, because every branch is a way somebody either stays on an
 * old bundle for a week or loses something they were doing, and both have
 * happened (see `in-call-state.ts` and the 2026-09-30 desktop field test that
 * wrote this). It decides between two things only: do nothing visible beyond
 * the quiet indicator (`components/layout/update-indicator.tsx`, always there
 * once there is something to take, never opened by itself), or reload the page
 * on its own at a moment nobody will notice. The one third answer, the blocking
 * screen, is for a CRITICAL update and nothing else. Ordered, first match wins:
 *
 *  - up to date: nothing;
 *  - NOT YET ANNOUNCED: nothing. A new build is only told to an open page once
 *    a day (`announceAtFor` in `client-version.ts`) unless an operator pushed it,
 *    and a page that has not been told must not reload either;
 *  - CRITICAL (the operator's `client_force_update_in_call`, or a bundle built
 *    before `CLIENT_CRITICAL_MIN_BUILT_AT`): reload now, in a call or not. The
 *    one rule that ends a call, and only an operator can trigger it. If an
 *    automatic reload for this build already happened, the blocking screen
 *    instead, so it cannot loop;
 *  - IN A CALL: the indicator, never a reload. A reload ends a screen share (a
 *    browser cannot restore a capture without the picker) and drops the seat;
 *    the update waits for the hangup, it is not lost;
 *  - an automatic reload was already tried for this build: the indicator only.
 *    ONE per build, ever: whatever stopped it landing (a CDN still serving the
 *    old page, a deploy half propagated) is not cured by trying again in a loop;
 *  - watching a live party: the indicator (a reload is a rebuffer and a visible
 *    gap for a viewer who did nothing wrong);
 *  - the tab is HIDDEN: reload. Nobody is looking, and the composer's draft
 *    store keeps what was typed;
 *  - somebody is TYPING (text in the focused field, or a key in the last 20 s):
 *    the indicator;
 *  - the call ENDED a moment ago (`LEFT_CALL_RELOAD_MS`): reload. The popover
 *    promised this one;
 *  - out of date for longer than `maxStaleMs` (twelve hours by default,
 *    counted from the announcement): reload without asking. This is the window
 *    somebody left open for days, and the desktop app that is never closed;
 *  - the person has not touched the page for `idleReloadMs`: reload, because
 *    nobody is there to be interrupted;
 *  - otherwise the indicator.
 *
 * `client_force_update` is not in this list on purpose. It used to put a
 * blocking screen up for everybody on every deploy; on 2026-10-13 it was the
 * reason a user was shown "update" every few seconds. It now means "announce
 * this one at once, with emphasis", which is a matter of WHEN the page is told
 * (`isForcedBuild`) and how the indicator looks, not of whether it blocks.
 */

export const IDLE_RELOAD_MS = 3 * 60_000;
/** After a hangup, how long the page counts as "just left a call". */
export const LEFT_CALL_RELOAD_MS = 2 * 60_000;
export const DEFAULT_MAX_STALE_MS = 12 * 60 * 60_000;

export type UpdateAction = "none" | "indicator" | "auto-reload" | "block";

export interface UpdatePolicyInput {
  stale: boolean;
  /**
   * False while the build is held back for the daily announcement. Absent is
   * announced, for callers that do not hold anything back.
   */
  announced?: boolean;
  /** How long the deployed build has existed, or this page has known, in ms. */
  staleForMs: number;
  /** Time since the last key, click or touch on the page. */
  idleMs: number;
  inCall: boolean;
  watching: boolean;
  typing: boolean;
  /** The operator made it critical: reload even in a call. */
  critical?: boolean;
  /** `document.visibilityState === "hidden"`. */
  hidden?: boolean;
  /** Time since this page's last call ended, or null if it was never in one. */
  sinceCallEndedMs?: number | null;
  /** False when an automatic reload for this build already happened. */
  autoReloadAllowed: boolean;
  idleReloadMs?: number;
  maxStaleMs?: number;
}

export function decideUpdateAction(input: UpdatePolicyInput): UpdateAction {
  if (!input.stale || input.announced === false) {
    return "none";
  }
  if (input.critical) {
    return input.autoReloadAllowed ? "auto-reload" : "block";
  }
  if (input.inCall) {
    return "indicator";
  }
  if (!input.autoReloadAllowed) {
    return "indicator";
  }
  if (input.watching) {
    return "indicator";
  }
  if (input.hidden) {
    return "auto-reload";
  }
  if (input.typing) {
    return "indicator";
  }
  if (
    input.sinceCallEndedMs !== null &&
    input.sinceCallEndedMs !== undefined &&
    input.sinceCallEndedMs < LEFT_CALL_RELOAD_MS
  ) {
    return "auto-reload";
  }
  const maxStaleMs = input.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  if (maxStaleMs > 0 && input.staleForMs >= maxStaleMs) {
    return "auto-reload";
  }
  if (input.idleMs >= (input.idleReloadMs ?? IDLE_RELOAD_MS)) {
    return "auto-reload";
  }
  return "indicator";
}

/**
 * Whether the blocking "atualização necessária" screen is up: stale and
 * CRITICAL, in a call too (the page reloads by itself, and this is what is on
 * screen if that reload does not land). Nothing else blocks: the force switch
 * only makes the indicator louder.
 */
export function isBlockingUpdate(build: {
  stale: boolean;
  critical?: boolean;
}): boolean {
  return build.stale && Boolean(build.critical);
}

/**
 * `VITE_UPDATE_MAX_STALE_HOURS`, in hours, for the long-stale rule. Unset or
 * unusable is the twelve-hour default; `0` turns the rule off (the idle rule and
 * the indicator still apply). A build-time value on purpose: it is tuned once,
 * not flipped live, and the live lever for urgency is the operator's force
 * switch.
 */
export function maxStaleMsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_STALE_MS;
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    return DEFAULT_MAX_STALE_MS;
  }
  return Math.round(hours * 60 * 60_000);
}

// ------------------------------------------------------------ the loop guard

const ATTEMPT_KEY = "pqp:update-auto-reload";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

interface Attempt {
  target: string;
  at: number;
}

/** How many builds the guard remembers: enough that A, B, A, B never gets a second go at A. */
const MAX_ATTEMPTS = 20;

/** Every build this session has already reloaded toward, oldest first. */
function readAttempts(storage: StorageLike): Attempt[] {
  try {
    const raw = storage.getItem(ATTEMPT_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    // The first version of the guard kept one `{ target, at }`.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((item) => {
      const { target, at } = (item ?? {}) as Partial<Attempt>;
      return typeof target === "string" && typeof at === "number"
        ? [{ target, at }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * Whether an automatic reload toward `target` may happen: once per target
 * build, for as long as this session lasts.
 *
 * It used to be once per quarter of an hour, which is a loop with a long period:
 * a page that keeps landing on the build it was already on (a CDN serving the
 * old page, a deploy half propagated) would reload itself all day. It
 * remembers every build it has tried, not only the last one, so a target that
 * alternates (a rollback, a CDN answering with two builds in turn) gets one
 * reload per build and no more. The person's own click on the indicator is
 * never limited by this.
 *
 * `sessionStorage` survives the reload this guards, which in-memory state does
 * not, so it is the only honest record; where it cannot be read or written
 * (private mode, storage off) this answers NO rather than reload with no way to
 * tell it has already tried (the same rule as `chunk-reload.ts`).
 */
export function autoReloadAllowed(
  target: string,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(`${ATTEMPT_KEY}:probe`, "1");
  } catch {
    return false;
  }
  return !readAttempts(storage).some((attempt) => attempt.target === target);
}

/**
 * Take the record back: an automatic reload that was written down and then
 * refused at the last moment (somebody joined a call, or started typing, while
 * the worker was being brought up) never happened, and must not use up this
 * build's one reload.
 */
export function forgetAutoReload(
  target: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    const kept = readAttempts(storage).filter((attempt) => attempt.target !== target);
    storage.setItem(ATTEMPT_KEY, JSON.stringify(kept));
  } catch {
    // Nothing to do: the guard stays, and the person's own click still works.
  }
}

/** Returns false when the record could not be kept, in which case do not reload. */
export function recordAutoReload(
  target: string,
  now: number,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) {
    return false;
  }
  try {
    const kept = readAttempts(storage)
      .filter((attempt) => attempt.target !== target)
      .slice(-(MAX_ATTEMPTS - 1));
    storage.setItem(ATTEMPT_KEY, JSON.stringify([...kept, { target, at: now }]));
    return true;
  } catch {
    return false;
  }
}

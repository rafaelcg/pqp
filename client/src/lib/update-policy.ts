/**
 * WHEN a page that knows it is out of date does something about it.
 *
 * One pure function, because every branch is a way somebody either stays on an
 * old bundle for a week or loses something they were doing, and both have
 * happened (see `update-snooze.ts`, `in-call-state.ts`, and the 2026-09-30
 * desktop field test that wrote this). Ordered, first match wins:
 *
 *  - up to date: nothing;
 *  - CRITICAL (the operator's `client_force_update_in_call`, or a bundle built
 *    before `CLIENT_CRITICAL_MIN_BUILT_AT`): reload now, in a call or not. The
 *    one rule that ends a call, and only an operator can trigger it. If an
 *    automatic reload for this build already failed to land, the blocking
 *    screen instead, so it cannot loop;
 *  - IN A CALL: only the lime in-call banner, never a reload and never the
 *    blocking screen. A reload ends a screen share (a browser cannot restore a
 *    capture without the picker) and drops the seat; the update waits for the
 *    hangup, it is not lost;
 *  - the operator forced it: the blocking screen, one button, no dismissal;
 *  - an automatic reload was already tried for this build a moment ago: the card
 *    only. Whatever stopped the reload from landing (a CDN still serving the old
 *    page, a deploy half propagated) is not cured by trying again in a loop;
 *  - watching a live party: the card (a reload is a rebuffer and a visible gap
 *    for a viewer who did nothing wrong);
 *  - the tab is HIDDEN: reload. Nobody is looking, and the composer's draft
 *    store keeps what was typed;
 *  - somebody is TYPING (text in the focused field, or a key in the last 20 s):
 *    the card;
 *  - the call ENDED a moment ago (`LEFT_CALL_RELOAD_MS`): reload. This is the
 *    update the in-call banner promised;
 *  - out of date for longer than `maxStaleMs` (twelve hours by default): reload
 *    without asking. This is the window somebody left open overnight, and the
 *    desktop app that is never closed;
 *  - the person has not touched the page for `idleReloadMs`: reload, because
 *    nobody is there to be interrupted;
 *  - otherwise the card, which comes back after "Later".
 */

export const IDLE_RELOAD_MS = 3 * 60_000;
/** After a hangup, how long the page counts as "just left a call". */
export const LEFT_CALL_RELOAD_MS = 2 * 60_000;
export const DEFAULT_MAX_STALE_MS = 12 * 60 * 60_000;
/** One automatic reload per target build per this long. */
export const AUTO_RELOAD_COOLDOWN_MS = 15 * 60_000;

export type UpdateAction = "none" | "banner" | "auto-reload" | "block";

export interface UpdatePolicyInput {
  stale: boolean;
  /** The operator made this update mandatory (`lib/client-version.ts`). */
  forced: boolean;
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
  /** False when an automatic reload for this build already happened lately. */
  autoReloadAllowed: boolean;
  idleReloadMs?: number;
  maxStaleMs?: number;
}

export function decideUpdateAction(input: UpdatePolicyInput): UpdateAction {
  if (!input.stale) {
    return "none";
  }
  if (input.critical) {
    return input.autoReloadAllowed ? "auto-reload" : "block";
  }
  if (input.inCall) {
    return "banner";
  }
  if (input.forced) {
    return "block";
  }
  if (!input.autoReloadAllowed) {
    return "banner";
  }
  if (input.watching) {
    return "banner";
  }
  if (input.hidden) {
    return "auto-reload";
  }
  if (input.typing) {
    return "banner";
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
  return "banner";
}

/**
 * Whether the blocking "atualização necessária" screen is up: forced, stale and
 * nobody in a call. The same rule as `decideUpdateAction`'s, asked without the
 * parts that only matter to the automatic reload, so the screen and the policy
 * can never disagree about it.
 */
export function isBlockingUpdate(
  build: { stale: boolean; forced: boolean; critical?: boolean },
  inCall: boolean,
): boolean {
  return (
    decideUpdateAction({
      stale: build.stale,
      forced: build.forced,
      // A critical build reloads by itself (`BuildWatcher`), and the screen is
      // up as well, in a call too, so a reload that does not land still leaves
      // the one button and nothing else.
      critical: build.critical,
      staleForMs: 0,
      idleMs: 0,
      inCall,
      watching: false,
      typing: false,
      autoReloadAllowed: !build.critical,
    }) === "block"
  );
}

/**
 * `VITE_UPDATE_MAX_STALE_HOURS`, in hours, for the long-stale rule. Unset or
 * unusable is the twelve-hour default; `0` turns the rule off (the idle rule and
 * the card still apply). A build-time value on purpose: it is tuned once, not
 * flipped live, and the live lever for urgency is the operator's force switch.
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

function readAttempt(storage: StorageLike): Attempt | null {
  try {
    const raw = storage.getItem(ATTEMPT_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<Attempt>;
    return typeof parsed.target === "string" && typeof parsed.at === "number"
      ? { target: parsed.target, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether an automatic reload toward `target` may happen now.
 *
 * `sessionStorage` survives the reload this guards, which in-memory state does
 * not, so it is the only honest record; where it cannot be read or written
 * (private mode, storage off) this answers NO rather than reload with no way to
 * tell it has already tried (the same rule as `chunk-reload.ts`).
 */
export function autoReloadAllowed(
  target: string,
  now: number,
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
  const last = readAttempt(storage);
  if (!last || last.target !== target) {
    return true;
  }
  return now - last.at >= AUTO_RELOAD_COOLDOWN_MS;
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
    storage.setItem(ATTEMPT_KEY, JSON.stringify({ target, at: now }));
    return true;
  } catch {
    return false;
  }
}

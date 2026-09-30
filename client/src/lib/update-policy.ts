/**
 * WHEN a page that knows it is out of date does something about it.
 *
 * One pure function, because every branch is a way somebody either stays on an
 * old bundle for a week or loses something they were doing, and both have
 * happened (see `update-snooze.ts`, `in-call-state.ts`, and the 2026-09-30
 * desktop field test that wrote this). Ordered, first match wins:
 *
 *  - up to date: nothing;
 *  - IN A CALL: only the quiet card, never a reload and never the blocking
 *    screen. A reload ends a screen share (a browser cannot restore a capture
 *    without the picker) and drops the seat; the update waits for the hangup,
 *    it is not lost;
 *  - the operator forced it: the blocking screen, one button, no dismissal;
 *  - an automatic reload was already tried for this build a moment ago: the card
 *    only. Whatever stopped the reload from landing (a CDN still serving the old
 *    page, a deploy half propagated) is not cured by trying again in a loop;
 *  - out of date for longer than `maxStaleMs` (twelve hours by default): reload
 *    without asking. This is the window somebody left open overnight, and the
 *    desktop app that is never closed;
 *  - the person has not touched the page for `idleReloadMs`: reload, because
 *    nobody is there to be interrupted;
 *  - otherwise the card, which comes back after "Later".
 *
 * Both automatic branches also refuse while somebody is TYPING (a draft is
 * saved, but a reload mid-sentence still loses the caret and the moment) or
 * WATCHING a live party (a reload is a rebuffer and a visible gap for a viewer
 * who did nothing wrong). They fall through to the card instead.
 */

export const IDLE_RELOAD_MS = 3 * 60_000;
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
  /** False when an automatic reload for this build already happened lately. */
  autoReloadAllowed: boolean;
  idleReloadMs?: number;
  maxStaleMs?: number;
}

export function decideUpdateAction(input: UpdatePolicyInput): UpdateAction {
  if (!input.stale) {
    return "none";
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
  const occupied = input.typing || input.watching;
  if (occupied) {
    return "banner";
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
  build: { stale: boolean; forced: boolean },
  inCall: boolean,
): boolean {
  return (
    decideUpdateAction({
      stale: build.stale,
      forced: build.forced,
      staleForMs: 0,
      idleMs: 0,
      inCall,
      watching: false,
      typing: false,
      autoReloadAllowed: true,
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

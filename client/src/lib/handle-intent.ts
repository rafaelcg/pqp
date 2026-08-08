/**
 * Two intentions that have to survive a sign-up.
 *
 * THIS IS THE INVITE BUG AGAIN, in two new shapes. `signedOutRedirectPath`
 * already fixed the version where somebody clicks an invite link, signs up, and
 * lands on an empty hub with the code thrown away — see `lib/app-route.ts`, and
 * note that the fix there works because the intent is IN THE PATH and the path
 * is what Clerk is handed. Neither of these two is in the path:
 *
 *  - CLAIM. Somebody types `neymar` into `pqp.gg/garanta`, likes what they see,
 *    and hits sign-up. The word they typed exists only in a React state that a
 *    hosted auth round trip destroys. Without this they arrive at `/app` with an
 *    auto-generated handle and no memory of the name that brought them.
 *  - ADD. Somebody opens `pqp.gg/@rafa` and hits "Me adiciona no pqp". They have
 *    no account. After signing up they should end up connected to Rafa, which is
 *    the entire reason Rafa shared the link — and the reason this feature can
 *    grow at all.
 *
 * WHY LOCALSTORAGE. `sessionStorage` survives a same-tab redirect, but not every
 * Clerk configuration is a same-tab redirect: a modal is one tab, a hosted page
 * is a navigation, and an OAuth provider can hand the session back in a new one.
 * `localStorage` is the only store that covers all three.
 *
 * WHY A TTL. `localStorage` is forever, and forever is wrong for an intention.
 * Without an expiry, somebody who abandons a signup in March gets an unexplained
 * friend request sent on their behalf in July. An hour is longer than any signup
 * takes and shorter than anybody's memory of having started one.
 *
 * Every function tolerates storage being denied (Safari private mode, an
 * embedded webview) by doing nothing. Failing closed means the intent is lost,
 * which costs one extra click; failing open would mean acting on somebody's
 * behalf without a record of them asking.
 */

const CLAIM_KEY = "pqp:pending-handle-claim";
const ADD_KEY = "pqp:pending-handle-add";

/** Long enough for a slow signup, short enough not to be a surprise later. */
export const HANDLE_INTENT_TTL_MS = 60 * 60 * 1000;

interface StoredIntent {
  handle: string;
  at: number;
}

type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function write(
  storage: WritableStorage | null,
  key: string,
  handle: string,
  now: number,
): void {
  if (!storage || !handle) {
    return;
  }
  try {
    storage.setItem(key, JSON.stringify({ handle, at: now } satisfies StoredIntent));
  } catch {
    // Storage denied. One extra click is the whole cost.
  }
}

/**
 * Read and CONSUME. Never a plain read: both of these cause an action, and an
 * intent that survives the action it caused is an action that repeats — a
 * friend request re-sent on every page load, a handle re-claimed on every
 * reload and spending the rename cooldown doing it.
 */
function take(
  storage: WritableStorage | null,
  key: string,
  now: number,
): string | null {
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(key);
    if (raw !== null) {
      storage.removeItem(key);
    }
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as StoredIntent).handle !== "string" ||
      typeof (parsed as StoredIntent).at !== "number"
    ) {
      return null;
    }
    const intent = parsed as StoredIntent;
    if (now - intent.at > HANDLE_INTENT_TTL_MS) {
      return null;
    }
    return intent.handle || null;
  } catch {
    // User-writable storage. Anything unreadable is "no intent".
    return null;
  }
}

export function stashHandleClaim(
  storage: WritableStorage | null,
  handle: string,
  now: number = Date.now(),
): void {
  write(storage, CLAIM_KEY, handle, now);
}

export function takeHandleClaim(
  storage: WritableStorage | null,
  now: number = Date.now(),
): string | null {
  return take(storage, CLAIM_KEY, now);
}

export function stashAddIntent(
  storage: WritableStorage | null,
  handle: string,
  now: number = Date.now(),
): void {
  write(storage, ADD_KEY, handle, now);
}

export function takeAddIntent(
  storage: WritableStorage | null,
  now: number = Date.now(),
): string | null {
  return take(storage, ADD_KEY, now);
}

/**
 * `?add=rafa` on any `/app` URL.
 *
 * The public profile's CTA sends people to `/app?add=<handle>` when they are
 * already signed in — no storage round trip needed for that case, and a URL is
 * the honest way to express "this navigation means something". Only the shape is
 * checked here; whether the handle exists is the API's answer.
 */
export function addIntentFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("add");
  if (!raw) {
    return null;
  }
  const handle = raw.replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{1,18}[a-z0-9]$/.test(handle) ? handle : null;
}

/** The storage this module wants, or null where there is none. */
export function intentStorage(): WritableStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

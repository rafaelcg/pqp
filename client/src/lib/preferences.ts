/**
 * Outbound half of cross-device settings.
 *
 * localStorage stays the fast path — it is what the boot script and the first
 * render read, so it keeps the app flash-free and usable offline. The server
 * copy is what makes a setting follow the user to the next device, and it is
 * written from here.
 *
 * Direction matters: the server wins on read (applied when `/api/me` resolves)
 * and the user wins on write. Boot never writes, because a tab that has been
 * open since yesterday would otherwise push its stale copy over the choice the
 * user just made on their phone.
 */

import { useSyncExternalStore } from "react";
import type { UserPreferences } from "@pqp/shared";
import { updatePreferences } from "@/lib/api";

/**
 * A volume slider emits a change per pixel of drag. Coalescing a burst into one
 * request keeps a single drag from spending the whole per-user write budget.
 */
const SYNC_DEBOUNCE_MS = 500;

let pending: UserPreferences = {};
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long a value whose request failed may still ride along with the next
 * change. Past that it is dropped: the account may have moved on from another
 * device, and replaying an old value over a newer one is exactly what boot
 * refuses to do (see the header). The tab still says the account did not get
 * it, and the value stays on this device.
 */
export const UNSENT_TTL_MS = 60_000;

/**
 * Keys whose last request failed for a reason a retry can fix (offline, a 5xx,
 * a 429), with the value to send again and when it failed. A refusal of the
 * body itself (any other 4xx) is not kept: sent again it would fail again, and
 * take every later change from this tab down with it.
 */
const unsent = new Map<keyof UserPreferences, { value: unknown; at: number }>();

function retryable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || status === 0) {
    return true;
  }
  return status === 429 || status >= 500;
}
/** Per key, the request that last carried it: only that one may report on it. */
const latestRequest = new Map<keyof UserPreferences, number>();
let requestCounter = 0;

/**
 * The account the queue belongs to. A retry is replayed through the signed-in
 * session, so values left from one account must never be sent as another's.
 */
let account: string | null = null;

let failedKeys: readonly (keyof UserPreferences)[] = [];
const listeners = new Set<() => void>();

function setFailedKeys(next: readonly (keyof UserPreferences)[]): void {
  if (
    next.length === failedKeys.length &&
    next.every((key, index) => key === failedKeys[index])
  ) {
    return;
  }
  failedKeys = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Called once the signed-in account is known. A different account drops
 * everything queued or retained for the previous one, and a request still in
 * flight for it no longer reports.
 */
export function bindPreferenceSyncAccount(id: string): void {
  if (account !== null && account !== id) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = {};
    unsent.clear();
    latestRequest.clear();
    setFailedKeys([]);
  }
  account = id;
}

function flush(): void {
  timer = null;
  const owner = account;
  // A key whose last request failed rides along with the next change, under
  // whatever was queued since (the newer value wins), for a minute at most.
  const retained: Record<string, unknown> = {};
  const now = Date.now();
  for (const [key, entry] of unsent) {
    if (now - entry.at > UNSENT_TTL_MS) {
      unsent.delete(key);
    } else {
      retained[key] = entry.value;
    }
  }
  const body: UserPreferences = { ...(retained as UserPreferences), ...pending };
  pending = {};
  const keys = Object.keys(body) as (keyof UserPreferences)[];
  if (keys.length === 0) {
    return;
  }
  const request = ++requestCounter;
  for (const key of keys) {
    latestRequest.set(key, request);
  }
  // Local-first by design: the value is already saved on this device, so a
  // failed sync costs cross-device propagation rather than the setting itself.
  // It is not silent, though: the settings tabs read `failedPreferenceKeys` and
  // say so, and a change within the next minute sends the unsent keys again. Signed-out
  // marketing routes land here too, where no tab is open to say anything.
  void updatePreferences(body).then(
    () => settle(owner, request, keys, body, null),
    (error: unknown) => settle(owner, request, keys, body, error ?? new Error("failed")),
  );
}

function settle(
  owner: string | null,
  request: number,
  keys: readonly (keyof UserPreferences)[],
  body: UserPreferences,
  error: unknown,
): void {
  const ok = error === null;
  // Sent for an account that is no longer signed in here: nothing to keep.
  if (owner !== account) {
    return;
  }
  let failed = [...failedKeys];
  for (const key of keys) {
    // A newer request carries this key now and answers for it.
    if (latestRequest.get(key) !== request) {
      continue;
    }
    failed = failed.filter((other) => other !== key);
    if (ok) {
      unsent.delete(key);
    } else {
      if (retryable(error)) {
        // The clock runs from the first failure of this value, not the
        // latest: a value that keeps failing must not stay fresh forever.
        const kept = unsent.get(key);
        const at = kept && Object.is(kept.value, body[key]) ? kept.at : Date.now();
        unsent.set(key, { value: body[key], at });
      } else {
        unsent.delete(key);
      }
      failed.push(key);
    }
  }
  setFailedKeys(failed);
}

/** Keys the account has not accepted yet. A new array only when it changes. */
export function failedPreferenceKeys(): readonly (keyof UserPreferences)[] {
  return failedKeys;
}

export function subscribePreferenceSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True while any of these preferences failed to reach the account and has not
 * been sent again successfully. For the tab that owns them to say so.
 */
export function usePreferenceSyncFailed(
  keys: readonly (keyof UserPreferences)[],
): boolean {
  const failed = useSyncExternalStore(
    subscribePreferenceSync,
    failedPreferenceKeys,
    failedPreferenceKeys,
  );
  return failed.some((key) => keys.includes(key));
}

/**
 * Queue a patch of just-changed keys. Later keys win over earlier ones.
 *
 * `immediate` is for discrete, deliberate choices — picking a theme is one
 * click, not a drag, and waiting out the debounce means a reload in the next
 * half second reads the *previous* server value and silently undoes the choice.
 */
export function queuePreferenceSync(
  patch: UserPreferences,
  { immediate = false }: { immediate?: boolean } = {},
): void {
  if (Object.keys(patch).length === 0) {
    return;
  }
  pending = { ...pending, ...patch };
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (immediate) {
    flush();
    return;
  }
  timer = setTimeout(flush, SYNC_DEBOUNCE_MS);
}

/**
 * Send anything still queued when the page goes away, so a drag that ends with
 * a reload or a tab close is not lost. `pagehide` fires in cases `unload` does
 * not, notably the bfcache path on iOS.
 */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (timer !== null) {
      clearTimeout(timer);
      flush();
    }
  });
}

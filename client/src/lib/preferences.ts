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

/** Keys whose last request failed, with the value to send again. */
const unsent: UserPreferences = {};
/** Per key, the request that last carried it: only that one may report on it. */
const latestRequest = new Map<keyof UserPreferences, number>();
let requestCounter = 0;

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

function flush(): void {
  timer = null;
  // A key whose last request failed rides along with the next change, under
  // whatever was queued since: the newer value wins.
  const body: UserPreferences = { ...unsent, ...pending };
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
  // say so, and the next change sends the unsent keys again. Signed-out
  // marketing routes land here too, where no tab is open to say anything.
  void updatePreferences(body).then(
    () => settle(request, keys, body, true),
    () => settle(request, keys, body, false),
  );
}

function settle(
  request: number,
  keys: readonly (keyof UserPreferences)[],
  body: UserPreferences,
  ok: boolean,
): void {
  let failed = [...failedKeys];
  for (const key of keys) {
    // A newer request carries this key now and answers for it.
    if (latestRequest.get(key) !== request) {
      continue;
    }
    failed = failed.filter((other) => other !== key);
    if (ok) {
      delete unsent[key];
    } else {
      (unsent as Record<string, unknown>)[key] = body[key];
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

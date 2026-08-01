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

import type { UserPreferences } from "@pqp/shared";
import { updatePreferences } from "@/lib/api";

/**
 * A volume slider emits a change per pixel of drag. Coalescing a burst into one
 * request keeps a single drag from spending the whole per-user write budget.
 */
const SYNC_DEBOUNCE_MS = 500;

let pending: UserPreferences = {};
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  const body = pending;
  pending = {};
  if (Object.keys(body).length === 0) {
    return;
  }
  // Best effort by design: the value is already saved locally, so a failed sync
  // costs cross-device propagation rather than the setting itself, and the next
  // change re-sends it. Signed-out marketing routes land here too.
  void updatePreferences(body).catch(() => {});
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

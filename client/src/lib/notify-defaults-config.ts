import { onConfigRefresh } from "@/lib/config-refresh";
import { getPushConfig } from "@/lib/push";

/**
 * The `desktop_notify_default_on` switch, read from `GET /api/push/config`
 * (see `docs/FEATURE_FLAGS.md`).
 *
 * A module-level answer rather than a hook, because the code that needs it is
 * plain functions in `lib/notifications.ts` (what level applies, whether a
 * banner may fire) that run from a socket frame. Unknown reads as off, which is
 * the behaviour before the flag existed, so an older API, a failed request and
 * the first second of a page all behave exactly as they did.
 *
 * Re-asked on focus and on a slow timer by `lib/config-refresh.ts`, so a flip
 * reaches an open tab without a reload. A failed ask keeps the last answer.
 */
let desktopNotifyDefaultOn = false;
const listeners = new Set<() => void>();

export function isDesktopNotifyDefaultOnEnabled(): boolean {
  return desktopNotifyDefaultOn;
}

/** Fires when the answer CHANGES, never on an ask that returned the same thing. */
export function onNotifyDefaultsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function apply(next: boolean): void {
  if (next === desktopNotifyDefaultOn) {
    return;
  }
  desktopNotifyDefaultOn = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Anything but an explicit `true` is off. */
export function desktopNotifyDefaultOnFromPushConfig(answer: {
  desktopNotifyDefaultOn?: unknown;
}): boolean {
  return answer.desktopNotifyDefaultOn === true;
}

/**
 * Two asks can be in flight at once (the page's first read and a focus
 * refresh) and the network does not promise to answer them in order. Each ask
 * takes a number; an answer is applied only if it is newer than the last one
 * applied. So a slow old `true` landing after the operator's flip to `false`
 * is dropped, while an older answer still counts when the newer ask failed.
 */
let asked = 0;
let applied = 0;

export async function loadNotifyDefaultsConfig(): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const next = desktopNotifyDefaultOnFromPushConfig(await getPushConfig());
    if (mine > applied) {
      applied = mine;
      apply(next);
    }
  } catch {
    // An older API or a network blip: keep what was there.
  }
}

/** Ask now and again on every config refresh. Returns the teardown. */
export function startNotifyDefaultsConfig(): () => void {
  void loadNotifyDefaultsConfig();
  const stop = onConfigRefresh(() => {
    void loadNotifyDefaultsConfig();
  });
  return () => {
    stop();
    // The answer belongs to the account that asked. Whoever signs in next
    // starts from off, and an ask still in flight from this one is dropped.
    asked += 1;
    applied = asked;
    apply(false);
  };
}

/** Test seam. */
export function setDesktopNotifyDefaultOnForTests(on: boolean): void {
  apply(on);
}

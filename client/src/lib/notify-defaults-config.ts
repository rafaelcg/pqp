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
 * Bumped by every ask. Two asks can be in flight at once (the page's first read
 * and a focus refresh), and the network does not promise to answer them in
 * order: only the newest ask may write, or an old `true` landing after the
 * operator's flip to `false` would put the switch back on until the next pass.
 */
let generation = 0;

export async function loadNotifyDefaultsConfig(): Promise<void> {
  generation += 1;
  const mine = generation;
  try {
    const next = desktopNotifyDefaultOnFromPushConfig(await getPushConfig());
    if (mine === generation) {
      apply(next);
    }
  } catch {
    // An older API or a network blip: keep what was there.
  }
}

/** Ask now and again on every config refresh. Returns the teardown. */
export function startNotifyDefaultsConfig(): () => void {
  void loadNotifyDefaultsConfig();
  return onConfigRefresh(() => {
    void loadNotifyDefaultsConfig();
  });
}

/** Test seam. */
export function setDesktopNotifyDefaultOnForTests(on: boolean): void {
  apply(on);
}

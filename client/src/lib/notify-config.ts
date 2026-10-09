import { onConfigRefresh } from "@/lib/config-refresh";
import { getPushConfig } from "@/lib/push";

/**
 * The notification switches the operator flips live, read from
 * `GET /api/push/config` (see `docs/FEATURE_FLAGS.md`).
 *
 * A module-level answer rather than a hook: the places that decide whether to
 * raise a banner are plain functions in `lib/notifications.ts` that run from a
 * socket frame, with no component to ask. Unknown reads as off, which is the
 * behaviour before the flags existed, so an older API, a failed request and
 * the first second of a page all behave exactly as they did.
 *
 * Re-asked on focus and on a slow timer by `lib/config-refresh.ts`, so a flip
 * reaches an open tab without a reload. A failed ask keeps the last answer:
 * stale beats blank.
 */
export interface NotifyConfig {
  /** `notify_open_channel`: the open channel banners while the window is away. */
  notifyOpenChannel: boolean;
}

const OFF: NotifyConfig = { notifyOpenChannel: false };

let current: NotifyConfig = OFF;

export function getNotifyConfig(): NotifyConfig {
  return current;
}

export function isNotifyOpenChannelEnabled(): boolean {
  return current.notifyOpenChannel;
}

/** Fold a `/api/push/config` answer into the switches. Anything but `true` is off. */
export function notifyConfigFromPushConfig(answer: {
  notifyOpenChannel?: unknown;
}): NotifyConfig {
  return { notifyOpenChannel: answer.notifyOpenChannel === true };
}

/**
 * Bumped by every ask. Two asks can be in flight at once (the page's first read
 * and a focus refresh), and the network does not promise to answer them in
 * order: only the newest ask may write, or an old `true` landing after the
 * operator's flip to `false` would put the switch back on until the next pass.
 */
let generation = 0;

export async function loadNotifyConfig(): Promise<void> {
  generation += 1;
  const mine = generation;
  try {
    const next = notifyConfigFromPushConfig(await getPushConfig());
    if (mine === generation) {
      current = next;
    }
  } catch {
    // An older API or a network blip: keep what was there.
  }
}

/** Ask now and again on every config refresh. Returns the teardown. */
export function startNotifyConfig(): () => void {
  void loadNotifyConfig();
  return onConfigRefresh(() => {
    void loadNotifyConfig();
  });
}

/** Test seam. */
export function setNotifyConfigForTests(next: Partial<NotifyConfig> | null): void {
  current = next ? { ...OFF, ...next } : OFF;
}

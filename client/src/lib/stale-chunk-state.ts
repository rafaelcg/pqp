import { useSyncExternalStore } from "react";

/**
 * Whether the "pqp updated, reload to continue" corner card is on screen.
 *
 * `recoverFromChunkLoadError` (`lib/chunk-reload.ts`) writes to this instead
 * of reloading whenever the tab is mid-call: a person watching a stale-chunk
 * failure happen has just navigated somewhere new, not asked to be dropped
 * from their call, so the fix waits for them to act instead of taking the
 * page out from under them. A plain module-level flag, read by
 * `StaleChunkBanner` (mounted once, next to `UpdatePrompt`, so it stays up
 * across every route).
 */

let visible = false;
const listeners = new Set<() => void>();

export function setStaleChunkBannerVisible(next: boolean): void {
  if (visible === next) {
    return;
  }
  visible = next;
  for (const listener of listeners) {
    listener();
  }
}

export function isStaleChunkBannerVisible(): boolean {
  return visible;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStaleChunkBannerVisible(): boolean {
  return useSyncExternalStore(subscribe, isStaleChunkBannerVisible, () => false);
}

/** Test seam. Nothing in the app resets a module singleton. */
export function resetStaleChunkBannerState(): void {
  visible = false;
  for (const listener of listeners) {
    listener();
  }
}

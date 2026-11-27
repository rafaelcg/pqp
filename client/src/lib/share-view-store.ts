import { useSyncExternalStore } from "react";
import {
  INITIAL_SHARE_VIEW_MODE,
  nextShareViewMode,
  type ShareViewEvent,
  type ShareViewMode,
} from "./share-view-mode";

/**
 * The share popout's mode, shared by the two places that act on it (issue
 * 1736): the popout itself (mounted at the app root) and the app shell, which
 * expands the call stage and puts the chat away while the mode is `theater`.
 *
 * One store rather than state in either component because both must agree on
 * the same answer in the same render: a popout still floating over a theater
 * that has already taken the pane is two copies of one picture.
 *
 * Per page, not stored: a reload starts every call as a popout.
 */

let mode: ShareViewMode = INITIAL_SHARE_VIEW_MODE;
const listeners = new Set<() => void>();

export function shareViewMode(): ShareViewMode {
  return mode;
}

export function dispatchShareView(event: ShareViewEvent): void {
  const next = nextShareViewMode(mode, event);
  if (next === mode) {
    return;
  }
  mode = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useShareViewMode(): ShareViewMode {
  return useSyncExternalStore(subscribe, shareViewMode, shareViewMode);
}

export function resetShareViewForTests(): void {
  mode = INITIAL_SHARE_VIEW_MODE;
  listeners.clear();
}

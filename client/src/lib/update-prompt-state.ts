import { useSyncExternalStore } from "react";

/**
 * Whether the "new build ready" card is on screen.
 *
 * `UpdatePrompt` is mounted in `main.tsx`, outside `App`, because a waiting
 * service worker matters on every route. The corner-hint queue lives inside
 * `App`. Both want the bottom-right corner, and before this they could stack.
 * This is the one bit of shared state that lets the queue yield: the update
 * card writes here, `winningCornerHint` reads it first.
 */

let showing = false;
const listeners = new Set<() => void>();

export function setUpdatePromptShowing(next: boolean): void {
  if (showing === next) {
    return;
  }
  showing = next;
  for (const listener of listeners) {
    listener();
  }
}

export function isUpdatePromptShowing(): boolean {
  return showing;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUpdatePromptShowing(): boolean {
  return useSyncExternalStore(subscribe, isUpdatePromptShowing, () => false);
}

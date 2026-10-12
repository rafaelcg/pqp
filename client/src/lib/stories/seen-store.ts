import { useSyncExternalStore } from "react";

/**
 * Stories this browser has watched since the page loaded, as the rings see it.
 *
 * The server learns about a view from the batched `POST /api/stories/views`
 * and folds it into `unseen` on the next strip fetch. Until then the ring has
 * to turn grey on its own, and it has to do it AFTER the viewer has closed
 * (design §4, "Ring turns seen": 120 ms after the close, so the change is
 * seen). So a view goes into `pending` while the viewer is open and is only
 * committed, which is what the rings read, when the viewer asks for it.
 */

const committed = new Set<string>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function publish(): void {
  snapshot = new Set(committed);
  for (const listener of [...listeners]) {
    listener();
  }
}

/** The viewer watched these: remember them, but do not repaint any ring yet. */
export function noteStoriesSeen(ids: Iterable<string>): void {
  for (const id of ids) {
    if (!committed.has(id)) {
      pending.add(id);
    }
  }
}

/** The viewer has closed: every pending view now shows on the rings. */
export function commitSeenStories(): void {
  if (pending.size === 0) {
    return;
  }
  for (const id of pending) {
    committed.add(id);
  }
  pending.clear();
  publish();
}

export function getSeenStories(): ReadonlySet<string> {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSeenStories(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSeenStories, getSeenStories);
}

/** Tests only. */
export function resetSeenStories(): void {
  committed.clear();
  pending.clear();
  publish();
}

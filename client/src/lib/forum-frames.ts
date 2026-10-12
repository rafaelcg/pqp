import type { ForumConfigUpdate, ForumPostRemoved, ForumPostUpsert } from "@pqp/shared";

/**
 * The forum frames (a post's row, its removal, the forum's tags and settings),
 * from the one socket handler in `App.tsx` to whichever forum pane is
 * mounted. The transport holds a single message handler by design, so App
 * stays the only reader of the socket and hands these on with one line; the
 * pane subscribes for as long as it is on screen.
 *
 * A frame for a forum nobody is looking at has no listener and is dropped,
 * which is correct: the list is read fresh when the forum is opened.
 */

export type ForumFrame = ForumPostUpsert | ForumPostRemoved | ForumConfigUpdate;

const listeners = new Set<(frame: ForumFrame) => void>();

export function dispatchForumFrame(frame: ForumFrame): void {
  for (const listener of listeners) {
    listener(frame);
  }
}

export function subscribeForumFrames(
  listener: (frame: ForumFrame) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const reconnectListeners = new Set<() => void>();

/**
 * The socket came back. Frames sent while it was down are gone, so an open
 * forum reads page 1 again and merges it (no skeleton, no flash).
 */
export function dispatchForumReconnected(): void {
  for (const listener of reconnectListeners) {
    listener();
  }
}

export function subscribeForumReconnected(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
  };
}

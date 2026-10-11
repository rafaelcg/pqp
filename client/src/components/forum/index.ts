/**
 * The forum pane's public surface, as App sees it. Forum PR 3a (the shell)
 * created this file with the contract; forum PR 3b (the pane) owns what is
 * behind it. See the header of `./forum-pane.tsx` for what each prop means.
 */
import type { ForumFrame } from "./forum-pane";

export { ForumPane, type ForumFrame, type ForumPaneProps } from "./forum-pane";

type ForumFrameListener = (frame: ForumFrame) => void;
const frameListeners = new Set<ForumFrameListener>();

/**
 * App's socket handler calls this for every `forum-post-upsert` and
 * `forum-post-removed` frame, whatever forum it names: the listener filters
 * by `forumId`. Synchronous and never throws into the socket handler.
 */
export function dispatchForumFrame(frame: ForumFrame): void {
  for (const listener of frameListeners) {
    try {
      listener(frame);
    } catch {
      // One broken listener must not stop the others or the socket.
    }
  }
}

/** The pane's side of `dispatchForumFrame`. Returns the unsubscribe. */
export function subscribeForumFrames(listener: ForumFrameListener): () => void {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}

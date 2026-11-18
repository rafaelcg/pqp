import type { JamFrame } from "@pqp/shared";

/**
 * The jam frames, from the one socket handler in `App.tsx` to the jam store.
 * Same arrangement as `lib/forum-frames.ts`: the transport holds one handler,
 * App stays the only reader of the socket and hands these on with one line.
 *
 * A frame for a channel nobody holds in the store has no effect, which is
 * right: the wall reads the list fresh when it is opened.
 */

const listeners = new Set<(frame: JamFrame) => void>();

export function dispatchJamFrame(frame: JamFrame): void {
  for (const listener of listeners) {
    listener(frame);
  }
}

export function subscribeJamFrames(listener: (frame: JamFrame) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const reconnectListeners = new Set<() => void>();

/** The socket came back: frames sent while it was down are gone, so re-read. */
export function dispatchJamReconnected(): void {
  for (const listener of reconnectListeners) {
    listener();
  }
}

export function subscribeJamReconnected(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
  };
}

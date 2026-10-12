import type { StoriesUpdate } from "@pqp/shared";

/**
 * The `stories-update` frame, handed from the socket to whoever draws stories.
 *
 * The frame carries no content (see `storiesUpdateSchema`): it names a strip
 * to refetch, and sometimes ids an open viewer may drop at once. App owns the
 * socket and knows nothing about strips; the strips know nothing about the
 * socket. This is the seam between them, the same shape as a DOM event bus
 * but typed, and with a "refresh everything" signal for a reconnect, after
 * which any frame sent while the socket was down is lost.
 */

export type StoriesSignal =
  | { kind: "update"; frame: StoriesUpdate }
  | { kind: "refresh" };

type Listener = (signal: StoriesSignal) => void;

const listeners = new Set<Listener>();

export function onStoriesSignal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(signal: StoriesSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch (error) {
      console.error("[stories] listener failed:", error);
    }
  }
}

/** App calls this with every `stories-update` frame. */
export function emitStoriesUpdate(frame: StoriesUpdate): void {
  emit({ kind: "update", frame });
}

/** After a reconnect: every strip refetches, since frames may have been missed. */
export function emitStoriesRefresh(): void {
  emit({ kind: "refresh" });
}

/** Does this signal ask the strip for `audience` to refetch? */
export function signalTouchesStrip(
  signal: StoriesSignal,
  audience: { kind: "server"; serverId: string } | { kind: "friends" },
): boolean {
  if (signal.kind === "refresh") {
    return true;
  }
  const { frame } = signal;
  // `own` is about the receiver's own stories, which every strip draws as
  // "Teu story", so it touches all of them.
  if (frame.scope === "own") {
    return true;
  }
  if (audience.kind === "friends") {
    return frame.scope === "friends";
  }
  return frame.scope === "server" && frame.serverId === audience.serverId;
}

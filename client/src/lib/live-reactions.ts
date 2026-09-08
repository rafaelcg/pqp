import type { LiveReactionCount, LiveReactionEmoji } from "@pqp/shared";

/**
 * Live reactions: the flag, and the one-hop bus between the voice controller
 * and the overlay that draws them.
 *
 * OFF BY DEFAULT, and off on a self-host that does nothing. The contract is the
 * usual one for a `VITE_` boolean in this repo (`dev-auth.ts`,
 * `voice-backend.ts`): a named predicate in a small module, string comparison
 * rather than truthiness, and never `import.meta.env` read inline in a
 * component. A build without the variable set has no bar, no overlay and never
 * sends the frame.
 */
export function isLiveReactionsEnabled(): boolean {
  return import.meta.env.VITE_LIVE_REACTIONS === "true";
}

export interface LiveReactionsWindow {
  channelId: string;
  items: LiveReactionCount[];
  seq: number;
}

type Listener = (window: LiveReactionsWindow) => void;

const listeners = new Set<Listener>();

/**
 * WHY A BUS AND NOT A PROP.
 *
 * `transport.onMessage` holds ONE handler, which `App.tsx` owns and routes from
 * (see `realtime.ts`), so a component cannot subscribe to a frame type. Every
 * other feature answers that by lifting the state into a controller and passing
 * it down, which is right for state. A coalesced window is not state: it
 * is an event with a 1.5 second lifetime, it is consumed by exactly one
 * component, and putting it in a controller snapshot would re-render the whole
 * call stage four times a second during a burst to move confetti.
 *
 * So the frame goes straight from the voice controller's switch to whoever is
 * drawing. Nothing here is stored: a window delivered to no listeners is
 * dropped, which is the correct behaviour for a client that is not looking at a
 * share.
 */
export function publishLiveReactions(window: LiveReactionsWindow): void {
  for (const listener of listeners) {
    listener(window);
  }
}

/** Returns the unsubscribe, for an effect cleanup. */
export function subscribeToLiveReactions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: forget every listener. */
export function resetLiveReactionListeners(): void {
  listeners.clear();
}

/**
 * The sender's own tap, drawn without waiting for the server.
 *
 * A round trip plus up to a full coalescing window is 300ms or so before your
 * own emoji appears, which is long enough to read as a button that did not
 * work, and long enough that people tap again. So the bar publishes a window of
 * one to itself the instant it is pressed. The server's window arrives later
 * and includes this tap a second time; two particles instead of one, among
 * dozens, is invisible, and it is a far better failure than a dead button.
 */
export function echoLocalLiveReaction(
  channelId: string,
  emoji: LiveReactionEmoji,
): void {
  publishLiveReactions({ channelId, items: [{ emoji, count: 1 }], seq: -1 });
}

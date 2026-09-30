/**
 * Evidence about the network from outside `/ws`, for the realtime transport.
 *
 * The media path and the signalling socket share one network but notice a
 * change at different speeds. LiveKit runs its own heartbeat and ICE checks
 * run every second or two, so the media side usually knows first: it drops
 * into "reconnecting" when the link goes, and back to "connected" the moment
 * it returns. The socket, meanwhile, is either sitting on a dead TCP
 * connection or waiting out a backoff timer. A hint lets the transport act on
 * what the media side already knows:
 *
 * - `up`: media just (re)connected, so the network works. A pending reconnect
 *   fires now, and an attempt stuck connecting on the old network is redone.
 * - `suspect`: media just lost its path. The socket is probed with one ping
 *   and a short deadline instead of waiting for the idle schedule.
 *
 * Hints never tear anything down on their own. Media keeps running while the
 * socket is away (`notifyDisconnected` in `hooks/use-voice.ts`), and a hint is
 * only ever a reason to check sooner.
 *
 * Module-level on purpose: the emitters (`livekit-session.ts`,
 * `peer-connection-manager.ts`) are created deep inside the voice controller
 * and have no handle on the transport, and threading one through every
 * constructor for a one-bit signal is more coupling than the signal is worth.
 */
export type NetworkHint = "up" | "suspect";

type Listener = (hint: NetworkHint) => void;

const listeners = new Set<Listener>();

export function emitNetworkHint(hint: NetworkHint): void {
  for (const listener of [...listeners]) {
    try {
      listener(hint);
    } catch {
      // A hint is advice; a broken listener must not break the emitter.
    }
  }
}

/** For tests: the listener set outlives a transport a test forgot to close. */
export function clearNetworkHintListeners(): void {
  listeners.clear();
}

/** Returns the unsubscribe. */
export function onNetworkHint(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

import type { BauPlusUpdateMessage } from "@pqp/shared";

/**
 * `bau-plus-update` frames, fanned out to whatever is on screen: an open pay
 * screen flips to paid the instant the provider confirms, the membership
 * manager and the renewal card re-read. A plain listener set rather than a
 * store, because nothing keeps the frame: each listener re-reads the API.
 */

type Listener = (message: BauPlusUpdateMessage) => void;

const listeners = new Set<Listener>();

export function emitBauPlusUpdate(message: BauPlusUpdateMessage): void {
  for (const listener of [...listeners]) {
    try {
      listener(message);
    } catch (error) {
      console.error("[bau-plus] update listener failed:", error);
    }
  }
}

export function onBauPlusUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

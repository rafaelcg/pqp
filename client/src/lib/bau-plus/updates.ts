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

/**
 * "Renovar" from somewhere that is not the creator's Baú (Configurações,
 * Assinaturas): the app opens that server's Baú and the feed opens the pay
 * sheet. The request waits here until that feed takes it, so the order in which
 * the two mount does not matter.
 */
let pendingPay: string | null = null;
const payListeners = new Set<(serverId: string) => void>();

export function requestBauPay(serverId: string): void {
  pendingPay = serverId;
  for (const listener of [...payListeners]) {
    listener(serverId);
  }
}

export function onBauPayRequest(listener: (serverId: string) => void): () => void {
  payListeners.add(listener);
  return () => {
    payListeners.delete(listener);
  };
}

export function takeBauPayRequest(serverId: string): boolean {
  if (pendingPay === serverId) {
    pendingPay = null;
    return true;
  }
  return false;
}

import { useSyncExternalStore } from "react";
import type { JamIntent } from "@/lib/jam-intent";
import { MINE_PUBLIC_JAM_PATH, NEW_PUBLIC_JAM_PATH, publicJamAppPath } from "@/lib/jam-public-links";

/**
 * Asking the app to open a public jam: the arrival intent from jam.pqp.gg
 * (`App`), a card on the Jam wall's "Públicas" shelf, a toast's "Ver". They
 * all say the same thing, so there is one way to say it, and the host
 * (`components/jam/jam-public-host.tsx`) is the only one that listens.
 *
 * The intent (record this instrument, like, report) rides along until the view
 * has acted on it, and is then dropped: an intent that outlives its action
 * repeats on the next visit (`lib/jam-intent.ts`).
 */

export interface PublicJamRequest {
  /** `new` starts a standalone public jam, `mine` opens "Tuas músicas". */
  target: string;
  intent: JamIntent | null;
  /** Moves on every request, so asking twice for the same song still opens it. */
  nonce: number;
}

let current: PublicJamRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Open a public jam in the app. */
export function openPublicJam(intent: JamIntent): void {
  nonce += 1;
  current = {
    target: intent.kind === "new" ? "new" : intent.kind === "mine" ? "mine" : intent.songId,
    intent,
    nonce,
  };
  emit();
}

/**
 * Open a public jam from somewhere that has only its id. NEVER starts the
 * music: opening a song shows it ready, and sound begins on the person's own
 * tap on play (user test round 2, m8: it started by itself, at volume, on a
 * song the person had not chosen to hear).
 */
export function openPublicJamById(songId: string): void {
  openPublicJam({ kind: "song", songId, record: false, instrument: null });
}

// The three things a door into public jams offers. Every door says them the same
// way, so there is one place that does them.

/** "Ouvir": the song, waiting for play. */
export function listenToPublicJam(songId: string): void {
  openPublicJamById(songId);
}

/** "Gravar minha parte": the song, with the studio opening on the instrument it asks for. */
export function recordOnPublicJam(songId: string): void {
  openPublicJam({ kind: "song", songId, record: true, instrument: null });
}

/** "Começar a minha": the sheet that starts a new public song. */
export function startPublicJam(): void {
  openPublicJam({ kind: "new" });
}

/** "Tuas músicas": the songs I started and the parts I sent, each with its state. */
export function openMyJams(): void {
  openPublicJam({ kind: "mine" });
}

/** The address a request opens. */
export function publicJamRequestPath(request: PublicJamRequest): string {
  return request.target === "new"
    ? NEW_PUBLIC_JAM_PATH
    : request.target === "mine"
      ? MINE_PUBLIC_JAM_PATH
      : publicJamAppPath(request.target);
}

/** The intent for `target` once, then nothing: the view that acts on it calls this. */
export function takePublicJamIntent(target: string): JamIntent | null {
  if (!current || current.target !== target || current.intent === null) {
    return null;
  }
  const { intent } = current;
  current = { ...current, intent: null };
  return intent;
}

export function peekPublicJamRequest(): PublicJamRequest | null {
  return current;
}

export function subscribePublicJamRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePublicJamRequest(): PublicJamRequest | null {
  return useSyncExternalStore(subscribePublicJamRequests, peekPublicJamRequest, () => null);
}

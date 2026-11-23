import { useCallback, useSyncExternalStore } from "react";

/**
 * `share_popout`: whether a call's picture is a popout inside the app window
 * instead of a stage that splits the pane with the chat. Per server, default
 * off, served by `GET /api/share/config?serverId=` as `sharePopout`.
 * github.com/rafaelcg/pqp/issues/1736.
 *
 * What it changes: the chat
 * keeps the whole pane, one share floats in a corner of the conversation area
 * and follows the person across channels, it fills that area only when they
 * maximize it, and a new share arrives as "Assistir" with no video received
 * until the click. Web and desktop only.
 *
 * The answer rides on the share config the call already asks for
 * (`share-guard-flag.ts` hands every answer here as it arrives), so this file
 * makes no request of its own. Unlike `share-fast-start.ts`, which the media
 * session reads when an event happens, this one decides what React draws, so
 * it is a store a component can subscribe to.
 *
 * Unknown is off: a server nobody has asked about, an API older than the flag
 * (no field), and a request that failed all leave the call exactly as it was.
 * A DM call is the deployment-wide answer, keyed "".
 */

const answers = new Map<string, boolean>();
const listeners = new Set<() => void>();
/** The harness forces it; production never calls this. */
let forced: boolean | null = null;

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function keyOf(serverId: string | null | undefined): string {
  return serverId ?? "";
}

export function recordSharePopout(serverId: string | null, on: boolean): void {
  const key = keyOf(serverId);
  if (answers.get(key) === on) {
    return;
  }
  answers.set(key, on);
  notify();
}

/** Force the answer for every server (e2e and local testing). `null` clears it. */
export function setSharePopout(on: boolean | null): void {
  if (forced === on) {
    return;
  }
  forced = on;
  notify();
}

/** Whether the popout is on for a call in this server (`null`: a DM call). */
export function sharePopoutActive(serverId: string | null | undefined): boolean {
  if (forced !== null) {
    return forced;
  }
  return answers.get(keyOf(serverId)) === true;
}

/**
 * Whether there is an answer for this server yet. "Unknown is off" is right
 * for drawing, but the call also needs to tell "off" from "not asked yet":
 * an answer that lands after the call's welcome must still hold the shares
 * that were already up (`setShareOptIn` in `use-voice.ts`).
 */
export function sharePopoutKnown(serverId: string | null | undefined): boolean {
  return forced !== null || answers.has(keyOf(serverId));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSharePopout(serverId: string | null | undefined): boolean {
  const read = useCallback(() => sharePopoutActive(serverId), [serverId]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useSharePopoutKnown(serverId: string | null | undefined): boolean {
  const read = useCallback(() => sharePopoutKnown(serverId), [serverId]);
  return useSyncExternalStore(subscribe, read, read);
}

export function resetSharePopoutForTests(): void {
  answers.clear();
  forced = null;
  notify();
}

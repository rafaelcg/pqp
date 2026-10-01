import { useSyncExternalStore } from "react";

/**
 * Whether this tab is in a voice call right now.
 *
 * Written by `App` from the voice controller's status, read by `UpdatePrompt`
 * (mounted in `main.tsx`, outside `App`, so it cannot see voice state directly).
 *
 * Why it exists: on 2026-09-06 a Pages deploy landed while a streamer was
 * presenting a film to 100 people. The "new version ready" card appeared, the
 * presenter pressed Reload, and the screen share died, because a browser
 * cannot restore a capture without the picker. Sixty people looked at black.
 * The update card must never ask a person in a call to reload; it waits until
 * they hang up. The waiting build is not lost, it is only late.
 */

let inCall = false;
const listeners = new Set<() => void>();

export function setInCall(next: boolean): void {
  if (inCall === next) {
    return;
  }
  inCall = next;
  for (const listener of listeners) {
    listener();
  }
}

export function isInCall(): boolean {
  return inCall;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInCall(): boolean {
  return useSyncExternalStore(subscribe, isInCall, () => false);
}

/**
 * Whether this tab is WATCHING a live party without a seat: looking at a film,
 * not in a call. A reload would not hang anyone up, so it is not `inCall`, but
 * it is a rebuffer and a gap in front of the person watching, so the automatic
 * update paths (`lib/update-policy.ts`) leave it alone. Written by `App` from
 * the same `watchingAParty` it already computes for the layout.
 */
let watching = false;

export function setWatchingParty(next: boolean): void {
  if (watching === next) {
    return;
  }
  watching = next;
  for (const listener of listeners) {
    listener();
  }
}

export function isWatchingParty(): boolean {
  return watching;
}

export function useWatchingParty(): boolean {
  return useSyncExternalStore(subscribe, isWatchingParty, () => false);
}

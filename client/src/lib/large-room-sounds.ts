import { useSyncExternalStore } from "react";

/**
 * Auto-muting join/leave sounds in a large call.
 *
 * Post-mortem item C2 (`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`):
 * "PILIM PILIM DE CONECTANDO TODA HORA", "como muta o som da galera" — a
 * watch party's voice room churns fast enough that every arrival and
 * departure plays its own cue, which stops being information and starts
 * being noise well before the room is actually crowded. Ten is comfortably
 * past a normal group call (mesh tops out at 8, `MESH_VOICE_LIMIT`) and
 * comfortably short of what a watch party's stage can hold, so it is the
 * line between "somebody arrived" and "everybody is arriving".
 *
 * The mute is automatic and reversible, never a removed feature: a person
 * who wants the cues anyway (running their own moderation, watching for who
 * is present) flips them back on from the call controls, and the choice
 * persists like every other sound preference in `lib/sounds.ts`. It is kept
 * in its own store rather than folded into `SoundState` because it answers a
 * different question (should THIS transient count of people change the
 * per-cue toggles' effect right now) and does not need to round-trip to the
 * account's synced preferences the way `voiceJoin`/`voiceLeave` do.
 */

export const LARGE_ROOM_SOUND_THRESHOLD = 10;

const STORAGE_KEY = "pqp:auto-mute-join-leave-large-rooms";

let current: boolean | null = null;
const listeners = new Set<(value: boolean) => void>();

function parseAutoMute(raw: unknown): boolean | null {
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  return null;
}

function readStoredAutoMute(): boolean | null {
  try {
    return parseAutoMute(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function ensureLoaded(): boolean {
  if (current === null) {
    // On by default: a person who has never touched the setting gets the
    // quiet room, which is what the post-mortem asked for.
    current = readStoredAutoMute() ?? true;
  }
  return current;
}

/** Whether join/leave cues auto-mute once a call passes the threshold. */
export function joinLeaveAutoMuteEnabled(): boolean {
  return ensureLoaded();
}

export function setJoinLeaveAutoMuteEnabled(enabled: boolean): void {
  const changed = ensureLoaded() !== enabled;
  current = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Not stored, but this session still holds it.
  }
  if (!changed) {
    return;
  }
  for (const listener of listeners) {
    listener(enabled);
  }
}

export function subscribeJoinLeaveAutoMute(
  listener: (value: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetJoinLeaveAutoMuteForTests(): void {
  current = null;
  listeners.clear();
}

export function useJoinLeaveAutoMuteEnabled(): boolean {
  return useSyncExternalStore(
    subscribeJoinLeaveAutoMute,
    joinLeaveAutoMuteEnabled,
    joinLeaveAutoMuteEnabled,
  );
}

/**
 * Should THIS join or leave stay silent?
 *
 * `participantCount` is everybody in the room including the person hearing
 * the cue — the same count a roster badge would show, not a "remote peers"
 * count that is one short of it.
 */
export function shouldSuppressJoinLeaveSound(
  participantCount: number,
  autoMuteEnabled: boolean,
): boolean {
  return autoMuteEnabled && participantCount > LARGE_ROOM_SOUND_THRESHOLD;
}

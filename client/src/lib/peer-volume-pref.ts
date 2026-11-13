/**
 * Per-person call volumes, remembered across reloads.
 *
 * `use-voice` keeps two maps, userId → 0..1: a person's voice and a person's
 * screen audio. They used to live only in memory, so every app restart and
 * every applied site update put everybody back at 100% (issue #1592).
 *
 * Keyed on userId, never peer id: the server mints a fresh peer id on every
 * join, the user id is the person. Only levels that differ from 1 are kept,
 * so the stored map is the list of people somebody actually adjusted, and
 * resetting a slider to 100% removes the entry.
 *
 * This browser only, on purpose: a level that suits one headset rarely suits
 * a phone speaker.
 */

const STORAGE_KEY = "pqp:peer-volumes";

/** A bound so a years-old profile cannot grow the blob without limit. */
export const MAX_STORED_VOLUMES = 500;

/** A slider emits a change per pixel of drag; one write per burst is enough. */
const SAVE_DEBOUNCE_MS = 400;

export interface StoredPeerVolumes {
  peer: Record<string, number>;
  screen: Record<string, number>;
}

function sanitize(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const kept = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, number] => {
      const [userId, value] = entry;
      return (
        userId.length > 0 &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value < 1
      );
    },
  );
  // A new person is added at the end of the map, so the tail is the most
  // recent: past the cap, the oldest adjustments are the ones forgotten.
  return Object.fromEntries(kept.slice(-MAX_STORED_VOLUMES));
}

/**
 * `map` with `userId` set to `volume` and moved to the END of the map.
 *
 * The cap keeps the tail, so a person must move there every time they are
 * adjusted: `{ ...map, [userId]: v }` alone keeps an existing key in its old
 * insertion slot, and somebody adjusted a minute ago could be the one dropped.
 */
export function withPeerVolume(
  map: Readonly<Record<string, number>>,
  userId: string,
  volume: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key !== userId) {
      next[key] = value;
    }
  }
  next[userId] = volume;
  return next;
}

/** Parse a stored blob; anything unreadable is an empty map, never a throw. */
export function parseStoredPeerVolumes(raw: string | null): StoredPeerVolumes {
  if (!raw) {
    return { peer: {}, screen: {} };
  }
  try {
    const parsed = JSON.parse(raw) as { peer?: unknown; screen?: unknown };
    return { peer: sanitize(parsed?.peer), screen: sanitize(parsed?.screen) };
  } catch {
    return { peer: {}, screen: {} };
  }
}

/** The volumes saved by an earlier session of this browser. */
export function loadPeerVolumes(): StoredPeerVolumes {
  try {
    return parseStoredPeerVolumes(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { peer: {}, screen: {} };
  }
}

let pending: StoredPeerVolumes | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function writeNow(volumes: StoredPeerVolumes): void {
  const peer = sanitize(volumes.peer);
  const screen = sanitize(volumes.screen);
  try {
    if (Object.keys(peer).length === 0 && Object.keys(screen).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ peer, screen }));
    }
  } catch {
    // Not stored is still set for this session.
  }
}

/** Write any save still waiting on the debounce. */
export function flushPeerVolumes(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending) {
    const volumes = pending;
    pending = null;
    writeNow(volumes);
  }
}

let unloadBound = false;

/**
 * Remember the current maps. Debounced; the last call in a burst wins, and a
 * page that unloads mid-burst still writes it.
 */
export function savePeerVolumes(volumes: StoredPeerVolumes): void {
  pending = volumes;
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = setTimeout(flushPeerVolumes, SAVE_DEBOUNCE_MS);
  if (!unloadBound && typeof window !== "undefined") {
    unloadBound = true;
    window.addEventListener("pagehide", flushPeerVolumes);
  }
}

/** Test seam: drop anything waiting so one test cannot write into the next. */
export function resetPeerVolumesForTests(): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = null;
  pending = null;
}

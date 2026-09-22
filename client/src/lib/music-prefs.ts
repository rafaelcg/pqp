import { useEffect, useSyncExternalStore } from "react";
import {
  getMusicSnapshot,
  setListening,
  subscribeMusic,
} from "@/lib/music-store";

/**
 * Personal music choices for this browser: whether the clip is on the
 * stage, whether speech ducks the track, and whether a room starting
 * music puts the player on automatically. Video never lives in the
 * sidebar; stage is the only picture.
 */

export type MusicPlacement = "hidden" | "stage";

export interface MusicPrefs {
  placement: MusicPlacement;
  ducking: boolean;
  autoJoin: boolean;
}

export type MusicPictureMode = "hidden" | "stage";

const PLACEMENT_KEY = "pqp:music-placement";
const DUCKING_KEY = "pqp:music-duck";
const AUTO_JOIN_KEY = "pqp:music-auto-join";

const DEFAULTS: MusicPrefs = {
  placement: "hidden",
  ducking: true,
  autoJoin: true,
};

const listeners = new Set<() => void>();

let snapshot: MusicPrefs = { ...DEFAULTS };
let loaded = false;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}

function parsePlacement(raw: string | null): MusicPlacement {
  return raw === "stage" ? "stage" : "hidden";
}

function parseFlag(raw: string | null, fallback: boolean): boolean {
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  return fallback;
}

function load(): MusicPrefs {
  if (loaded) {
    return snapshot;
  }
  loaded = true;
  snapshot = {
    placement: parsePlacement(readStored(PLACEMENT_KEY)),
    ducking: parseFlag(readStored(DUCKING_KEY), DEFAULTS.ducking),
    autoJoin: parseFlag(readStored(AUTO_JOIN_KEY), DEFAULTS.autoJoin),
  };
  return snapshot;
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setPrefs(partial: Partial<MusicPrefs>): void {
  const current = load();
  const next: MusicPrefs = { ...current, ...partial };
  if (
    next.placement === current.placement &&
    next.ducking === current.ducking &&
    next.autoJoin === current.autoJoin
  ) {
    return;
  }
  snapshot = next;
  writeStored(PLACEMENT_KEY, next.placement);
  writeStored(DUCKING_KEY, next.ducking ? "1" : "0");
  writeStored(AUTO_JOIN_KEY, next.autoJoin ? "1" : "0");
  emit();
}

export function getMusicPrefs(): MusicPrefs {
  return load();
}

export function subscribeMusicPrefs(listener: () => void): () => void {
  load();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMusicPrefs(): MusicPrefs {
  return useSyncExternalStore(subscribeMusicPrefs, getMusicPrefs, getMusicPrefs);
}

export function setMusicPlacement(placement: MusicPlacement): void {
  setPrefs({ placement });
}

/** Hide or stage: never two pictures, never a sidebar 16:9. */
export function musicPictureMode(
  prefs: Pick<MusicPrefs, "placement">,
): MusicPictureMode {
  return prefs.placement === "stage" ? "stage" : "hidden";
}

export function setMusicDucking(ducking: boolean): void {
  setPrefs({ ducking });
}

export function setMusicAutoJoin(autoJoin: boolean): void {
  setPrefs({ autoJoin });
}

export function useMusicPlacement(): MusicPlacement {
  return useMusicPrefs().placement;
}

export function useMusicDucking(): boolean {
  return useMusicPrefs().ducking;
}

export function useMusicAutoJoin(): boolean {
  return useMusicPrefs().autoJoin;
}

/**
 * Off + a track appearing (or already on when you sit down) means Ouvir
 * on the compact bar, not the player. A skip from one track to another is
 * not that transition.
 */
export function shouldAutoDeclineListen(input: {
  autoJoin: boolean;
  previousTrackId: string | null;
  nextTrackId: string | null;
  seatChanged: boolean;
}): boolean {
  if (input.autoJoin || input.nextTrackId === null) {
    return false;
  }
  if (input.seatChanged) {
    return true;
  }
  return input.previousTrackId === null;
}

let joinGate = { channelId: null as string | null, trackId: null as string | null };

export function applyMusicJoinGate(
  channelId: string | null,
  trackId: string | null,
  autoJoin: boolean,
): boolean {
  const seatChanged = joinGate.channelId !== channelId;
  if (seatChanged) {
    joinGate = { channelId, trackId: null };
  }
  const declined = shouldAutoDeclineListen({
    autoJoin,
    previousTrackId: joinGate.trackId,
    nextTrackId: trackId,
    seatChanged,
  });
  if (declined) {
    setListening(false);
  }
  joinGate.trackId = trackId;
  return declined;
}

function onMusicSessionChange() {
  const snap = getMusicSnapshot();
  applyMusicJoinGate(
    snap.channelId,
    snap.state?.current?.id ?? null,
    getMusicPrefs().autoJoin,
  );
}

let joinGateSubscribed = false;

function ensureJoinGate() {
  if (joinGateSubscribed) {
    return;
  }
  joinGateSubscribed = true;
  subscribeMusic(onMusicSessionChange);
}

/** Call once from the sidebar player so the gate is live for this tab. */
export function useMusicJoinGate(): void {
  useEffect(() => {
    ensureJoinGate();
    onMusicSessionChange();
  }, []);
}

export interface MusicStagePresence {
  active: boolean;
  title: string;
  addedByName: string;
  addedByUserId: string;
}

export function musicStagePictureActive(input: {
  hasCurrent: boolean;
  listening: boolean;
  onStage: boolean;
}): boolean {
  return input.hasCurrent && input.listening && input.onStage;
}

let presenceCache: MusicStagePresence = {
  active: false,
  title: "",
  addedByName: "",
  addedByUserId: "",
};

function getMusicStagePresence(): MusicStagePresence {
  const snap = getMusicSnapshot();
  const current = snap.state?.current ?? null;
  const next: MusicStagePresence = {
    active: musicStagePictureActive({
      hasCurrent: Boolean(current),
      listening: snap.listening,
      onStage: load().placement === "stage",
    }),
    title: current?.title ?? "",
    addedByName: current?.addedByName ?? "",
    addedByUserId: current?.addedByUserId ?? "",
  };
  if (
    presenceCache.active === next.active &&
    presenceCache.title === next.title &&
    presenceCache.addedByName === next.addedByName &&
    presenceCache.addedByUserId === next.addedByUserId
  ) {
    return presenceCache;
  }
  presenceCache = next;
  return presenceCache;
}

function subscribeMusicStagePresence(listener: () => void): () => void {
  const unsubMusic = subscribeMusic(listener);
  const unsubPrefs = subscribeMusicPrefs(listener);
  return () => {
    unsubMusic();
    unsubPrefs();
  };
}

/**
 * Track / listening / local picture. A position sample must not re-render
 * the stage. Leaving the stage is the only way this turns off.
 */
export function useMusicStagePresence(): MusicStagePresence {
  return useSyncExternalStore(
    subscribeMusicStagePresence,
    getMusicStagePresence,
    getMusicStagePresence,
  );
}

export function resetMusicPrefsForTests(): void {
  snapshot = { ...DEFAULTS };
  loaded = false;
  listeners.clear();
  joinGate = { channelId: null, trackId: null };
  presenceCache = {
    active: false,
    title: "",
    addedByName: "",
    addedByUserId: "",
  };
}

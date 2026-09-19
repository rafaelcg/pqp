import { useEffect, useSyncExternalStore } from "react";
import {
  getMusicSnapshot,
  setListening,
  subscribeMusic,
} from "@/lib/music-store";

/**
 * Personal music choices for this browser: where the video lives, whether
 * speech ducks the track, and whether a room starting music puts the player
 * on automatically. Kept out of `music-store.ts` so the room's queue and a
 * later controls PR can merge without touching this file.
 */

export type MusicPlacement = "panel" | "stage";

export interface MusicPrefs {
  placement: MusicPlacement;
  ducking: boolean;
  autoJoin: boolean;
  /** Local picture. Stage and the sheet share this so hide-video hides both. */
  showVideo: boolean;
}

export type MusicPictureMode = "hidden" | "panel" | "stage";

const PLACEMENT_KEY = "pqp:music-placement";
const DUCKING_KEY = "pqp:music-duck";
const AUTO_JOIN_KEY = "pqp:music-auto-join";
const VIDEO_KEY = "pqp:music-video";

const DEFAULTS: MusicPrefs = {
  placement: "panel",
  ducking: true,
  autoJoin: true,
  showVideo: false,
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
  return raw === "stage" ? "stage" : "panel";
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
    showVideo: parseFlag(readStored(VIDEO_KEY), DEFAULTS.showVideo),
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
    next.autoJoin === current.autoJoin &&
    next.showVideo === current.showVideo
  ) {
    return;
  }
  snapshot = next;
  writeStored(PLACEMENT_KEY, next.placement);
  writeStored(DUCKING_KEY, next.ducking ? "1" : "0");
  writeStored(AUTO_JOIN_KEY, next.autoJoin ? "1" : "0");
  writeStored(VIDEO_KEY, next.showVideo ? "1" : "0");
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
  if (placement === "stage") {
    setPrefs({ placement, showVideo: true });
    return;
  }
  setPrefs({ placement });
}

export function setMusicShowVideo(showVideo: boolean): void {
  setPrefs({ showVideo });
}

/** Hide, sheet, or stage: never two pictures. */
export function musicPictureMode(
  prefs: Pick<MusicPrefs, "placement" | "showVideo">,
): MusicPictureMode {
  if (!prefs.showVideo) {
    return "hidden";
  }
  return prefs.placement === "stage" ? "stage" : "panel";
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
 * Off + a track appearing (or already on when you sit down) means the pill,
 * not the player. A skip from one track to another is not that transition.
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
  showVideo: boolean;
}): boolean {
  return input.hasCurrent && input.listening && input.showVideo;
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
      showVideo: load().showVideo,
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
 * the stage. Hiding video turns this off so the stage tile leaves with it.
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

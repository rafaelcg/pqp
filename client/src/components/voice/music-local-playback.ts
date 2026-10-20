import { useSyncExternalStore } from "react";
import type { YTPlayer } from "@/lib/youtube-iframe";
import {
  readStoredVolumeModel,
  toggledMuted,
  withMuted,
  withVolume,
  writeStoredVolumeModel,
  type MusicVolumeModel,
} from "@/lib/music-volume";

/**
 * THIS MACHINE'S SPEAKER, SHARED BY THE EMBED AND THE CHROME.
 *
 * The iframe stays in the sidebar dock so it is never reparented. The
 * compact bar and Fila live in the composer. Volume, mute, and tap-to-play
 * have to be one store or the two mounts disagree.
 */

export interface MusicLocalPlayback {
  volume: number;
  muted: boolean;
  /** The last audible level: where an unmute from zero goes back to. */
  restoreVolume: number;
  needsTap: boolean;
  /** The embed reported that YouTube will not play the current video here. */
  playbackFailed: boolean;
}

function freshSnapshot(): MusicLocalPlayback {
  const stored = readStoredVolumeModel();
  return {
    volume: stored.volume,
    muted: false,
    restoreVolume: stored.restoreVolume,
    needsTap: false,
    playbackFailed: false,
  };
}

let snapshot: MusicLocalPlayback = freshSnapshot();
let player: YTPlayer | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setMusicLocalPlayer(next: YTPlayer | null): void {
  player = next;
}

function model(): MusicVolumeModel {
  return {
    volume: snapshot.volume,
    muted: snapshot.muted,
    restoreVolume: snapshot.restoreVolume,
  };
}

/** Takes a model change: stores what is persistent, tells whoever listens. */
function commit(next: MusicVolumeModel): void {
  const current = model();
  if (
    next.volume === current.volume &&
    next.muted === current.muted &&
    next.restoreVolume === current.restoreVolume
  ) {
    return;
  }
  snapshot = { ...snapshot, ...next };
  writeStoredVolumeModel(next);
  emit();
}

/** A level chosen on purpose: clamped, remembered, and it unmutes. */
export function setMusicLocalVolume(volume: number): void {
  commit(withVolume(model(), volume));
}

export function setMusicLocalMuted(muted: boolean): void {
  commit(withMuted(model(), muted));
}

export function toggleMusicLocalMuted(): void {
  commit(toggledMuted(model()));
}

export function setMusicLocalNeedsTap(needsTap: boolean): void {
  if (snapshot.needsTap === needsTap) {
    return;
  }
  snapshot = { ...snapshot, needsTap };
  emit();
}

export function setMusicLocalPlaybackFailed(playbackFailed: boolean): void {
  if (snapshot.playbackFailed === playbackFailed) {
    return;
  }
  snapshot = { ...snapshot, playbackFailed };
  emit();
}

export function tapMusicLocalToPlay(): void {
  if (!player) {
    // Nothing answered, so the tap bought nothing: the button stays up
    // rather than disappearing over a player that is not playing.
    return;
  }
  if (!snapshot.muted) {
    player.unMute();
  }
  player.playVideo();
  if (snapshot.needsTap) {
    snapshot = { ...snapshot, needsTap: false };
    emit();
  }
}

export function subscribeMusicLocalPlayback(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMusicLocalPlayback(): MusicLocalPlayback {
  return snapshot;
}

export function useMusicLocalPlayback(): MusicLocalPlayback {
  return useSyncExternalStore(
    subscribeMusicLocalPlayback,
    getMusicLocalPlayback,
    getMusicLocalPlayback,
  );
}

export function resetMusicLocalPlaybackForTests(): void {
  snapshot = freshSnapshot();
  player = null;
  listeners.clear();
}

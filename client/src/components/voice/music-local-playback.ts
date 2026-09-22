import { useSyncExternalStore } from "react";
import type { YTPlayer } from "@/lib/youtube-iframe";
import { readMusicVolume, writeMusicVolume } from "@/components/voice/music-player-embed";

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
  needsTap: boolean;
}

let snapshot: MusicLocalPlayback = {
  volume: readMusicVolume(),
  muted: false,
  needsTap: false,
};
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

export function setMusicLocalVolume(volume: number): void {
  const next = Math.min(100, Math.max(0, volume));
  snapshot = { ...snapshot, volume: next, muted: false };
  writeMusicVolume(next);
  emit();
}

export function setMusicLocalMuted(muted: boolean): void {
  if (snapshot.muted === muted) {
    return;
  }
  snapshot = { ...snapshot, muted };
  emit();
}

export function toggleMusicLocalMuted(): void {
  setMusicLocalMuted(!snapshot.muted);
}

export function setMusicLocalNeedsTap(needsTap: boolean): void {
  if (snapshot.needsTap === needsTap) {
    return;
  }
  snapshot = { ...snapshot, needsTap };
  emit();
}

export function tapMusicLocalToPlay(): void {
  if (player && !snapshot.muted) {
    player.unMute();
  }
  player?.playVideo();
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
  snapshot = { volume: readMusicVolume(), muted: false, needsTap: false };
  player = null;
  listeners.clear();
}

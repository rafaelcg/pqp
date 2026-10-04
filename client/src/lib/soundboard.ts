import {
  soundboardBuiltin,
  SOUNDBOARD_BUILTINS,
  type SoundboardSound,
} from "@pqp/shared";
import { useEffect, useState } from "react";
import { fetchSoundboard } from "@/lib/api";
import { decodeAudioBuffer, playAudioBuffer, unlockSounds } from "@/lib/sounds";

const VOLUME_KEY = "pqp:soundboard-volume";
const MARK_MS = 2200;

const buffers = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<AudioBuffer | null>>();
const customUrls = new Map<string, { url: string; volume: number }>();

export interface SoundboardMark {
  userId: string;
  displayName: string;
  emoji: string;
  soundId: string;
  until: number;
}

const marks = new Map<string, SoundboardMark>();
let activeSoundId: string | null = null;
let activeUntil = 0;
const listeners = new Set<() => void>();
let sender: ((soundId: string) => void) | null = null;

/** The voice socket registers this while a call is up. */
export function registerSoundboardSender(
  next: (soundId: string) => void,
): () => void {
  sender = next;
  return () => {
    if (sender === next) {
      sender = null;
    }
  };
}

export function requestSoundboardPlay(soundId: string): void {
  sender?.(soundId);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function soundboardListenerVolume(): number {
  if (typeof localStorage === "undefined") {
    return 0.6;
  }
  const raw = localStorage.getItem(VOLUME_KEY);
  const value = raw === null ? 0.6 : Number(raw);
  if (!Number.isFinite(value)) {
    return 0.6;
  }
  return Math.min(1, Math.max(0, value));
}

export function setSoundboardListenerVolume(volume: number): void {
  const next = Math.min(1, Math.max(0, volume));
  localStorage.setItem(VOLUME_KEY, String(next));
  notify();
}

export function useSoundboardListenerVolume(): [number, (volume: number) => void] {
  const [volume, setVolume] = useState(soundboardListenerVolume);
  useEffect(
    () =>
      subscribe(() => {
        setVolume(soundboardListenerVolume());
      }),
    [],
  );
  return [
    volume,
    (next) => {
      setSoundboardListenerVolume(next);
      setVolume(next);
    },
  ];
}

export function noteSoundboardCatalog(sounds: readonly SoundboardSound[]): void {
  rememberCustom(sounds);
}

function rememberCustom(sounds: readonly SoundboardSound[]): void {
  for (const sound of sounds) {
    if (sound.url) {
      customUrls.set(sound.id, { url: sound.url, volume: sound.volume });
    }
  }
}

export async function prefetchSoundboard(serverId: string): Promise<void> {
  try {
    const page = await fetchSoundboard(serverId);
    rememberCustom(page.sounds);
  } catch {
    // The board still plays the built-in pack.
  }
  await Promise.all([
    ...SOUNDBOARD_BUILTINS.map((sound) =>
      warm(`/sounds/soundboard/${sound.file}`, sound.id),
    ),
    ...[...customUrls.entries()].map(([id, sound]) => warm(sound.url, id)),
  ]);
}

async function warm(url: string, id: string): Promise<void> {
  if (buffers.has(id) || loading.has(id)) {
    return;
  }
  const task = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      return await decodeAudioBuffer(await response.arrayBuffer());
    } catch {
      return null;
    }
  })();
  loading.set(id, task);
  const buffer = await task;
  loading.delete(id);
  if (buffer) {
    buffers.set(id, buffer);
  }
}

async function bufferFor(soundId: string): Promise<AudioBuffer | null> {
  const cached = buffers.get(soundId);
  if (cached) {
    return cached;
  }
  const builtin = soundboardBuiltin(soundId);
  if (builtin) {
    await warm(`/sounds/soundboard/${builtin.file}`, soundId);
    return buffers.get(soundId) ?? null;
  }
  const custom = customUrls.get(soundId);
  if (!custom) {
    return null;
  }
  await warm(custom.url, soundId);
  return buffers.get(soundId) ?? null;
}

function gainFor(soundId: string, listener: number): number {
  const sound = customUrls.get(soundId)?.volume ?? 1;
  return Math.min(1, Math.max(0, listener * sound));
}

/**
 * Play for this machine. A deafened listener passes `hear: false` and still
 * gets the float from `showSoundboardMark`.
 */
export async function playSoundboardClip(
  soundId: string,
  hear: boolean,
): Promise<void> {
  if (!hear) {
    return;
  }
  unlockSounds();
  const buffer = await bufferFor(soundId);
  if (!buffer) {
    return;
  }
  playAudioBuffer(buffer, gainFor(soundId, soundboardListenerVolume()));
}

let previewNode: AudioBufferSourceNode | null = null;

/** Local preview. Does not tell the room. A new preview stops the last one. */
export function previewSoundboardClip(soundId: string): void {
  void (async () => {
    unlockSounds();
    const buffer = await bufferFor(soundId);
    if (!buffer) {
      return;
    }
    if (previewNode) {
      try {
        previewNode.stop();
      } catch {
        // Already finished.
      }
    }
    previewNode = playAudioBuffer(buffer, gainFor(soundId, soundboardListenerVolume()));
  })();
}

export function showSoundboardMark(mark: Omit<SoundboardMark, "until">): void {
  const until = Date.now() + MARK_MS;
  marks.set(mark.userId, { ...mark, until });
  activeSoundId = mark.soundId;
  activeUntil = until;
  notify();
  window.setTimeout(() => {
    const current = marks.get(mark.userId);
    if (current && current.until === until) {
      marks.delete(mark.userId);
    }
    if (activeUntil === until) {
      activeSoundId = null;
    }
    notify();
  }, MARK_MS);
}

export function useSoundboardMark(userId: string | undefined): SoundboardMark | null {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  if (!userId) {
    return null;
  }
  const mark = marks.get(userId);
  if (!mark || mark.until < Date.now()) {
    return null;
  }
  return mark;
}

export function useSoundboardActiveId(): string | null {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  if (!activeSoundId || activeUntil < Date.now()) {
    return null;
  }
  return activeSoundId;
}

/** Light up the tile the moment you click, without waiting for the room echo. */
export function pulseSoundboardActive(soundId: string): void {
  const until = Date.now() + MARK_MS;
  activeSoundId = soundId;
  activeUntil = until;
  notify();
  window.setTimeout(() => {
    if (activeUntil === until) {
      activeSoundId = null;
      notify();
    }
  }, MARK_MS);
}

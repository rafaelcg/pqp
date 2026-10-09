import {
  soundboardBuiltin,
  SOUNDBOARD_BUILTINS,
  SOUNDBOARD_MAX_DURATION_MS,
  type SoundboardSound,
} from "@pqp/shared";
import { useEffect, useState } from "react";
import { fetchSoundboard } from "@/lib/api";
import {
  decodeAudioBuffer,
  sharedAudioContext,
  unlockSounds,
} from "@/lib/sounds";

const VOLUME_KEY = "pqp:soundboard-volume";
const MUTE_KEY = "pqp:soundboard-muted";
const MARK_MS = 2200;

const buffers = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<AudioBuffer | null>>();
const customUrls = new Map<
  string,
  { url: string; volume: number; serverId: string }
>();
const customNames = new Map<string, string>();

export interface SoundboardMark {
  userId: string;
  displayName: string;
  emoji: string;
  soundId: string;
  until: number;
}

const marks = new Map<string, SoundboardMark>();
const activeUntilById = new Map<string, number>();
const listeners = new Set<() => void>();
let sender: ((soundId: string) => void) | null = null;
let catalogServerId: string | null = null;
const catalogTokens = new Map<string, number>();

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

export function soundboardMuted(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }
  return localStorage.getItem(MUTE_KEY) === "1";
}

export function setSoundboardMuted(muted: boolean): void {
  localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  applySoundboardBus();
  notify();
}

export function useSoundboardMuted(): [boolean, (muted: boolean) => void] {
  const [muted, setMuted] = useState(soundboardMuted);
  useEffect(
    () =>
      subscribe(() => {
        setMuted(soundboardMuted());
      }),
    [],
  );
  return [
    muted,
    (next) => {
      setSoundboardMuted(next);
      setMuted(next);
    },
  ];
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
  applySoundboardBus();
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

/** The call this machine is in. Plays for that server can refresh the catalog. */
export function setSoundboardCatalogServer(serverId: string | null): void {
  catalogServerId = serverId;
  // Entering another server's call drops the previous server's custom clips
  // and their decoded audio, so playing across servers keeps at most one
  // board in memory. A null (the control unmounting) keeps what it has: the
  // same call may remount it a moment later.
  if (serverId === null) {
    return;
  }
  for (const [id, row] of customUrls) {
    if (row.serverId === serverId) {
      continue;
    }
    customUrls.delete(id);
    customNames.delete(id);
    buffers.delete(id);
    loading.delete(id);
  }
}

export function noteSoundboardCatalog(
  serverId: string,
  sounds: readonly SoundboardSound[],
): void {
  catalogTokens.set(serverId, (catalogTokens.get(serverId) ?? 0) + 1);
  rememberCustom(serverId, sounds);
}

function clipIdentity(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

function rememberCustom(
  serverId: string,
  sounds: readonly SoundboardSound[],
): void {
  const nextIds = new Set(sounds.map((sound) => sound.id));
  for (const [id, row] of customUrls) {
    if (row.serverId !== serverId || nextIds.has(id)) {
      continue;
    }
    customUrls.delete(id);
    customNames.delete(id);
    buffers.delete(id);
    loading.delete(id);
  }
  for (const sound of sounds) {
    customNames.set(sound.id, sound.name);
    if (!sound.url) {
      continue;
    }
    const previous = customUrls.get(sound.id);
    if (
      previous &&
      (previous.serverId !== serverId ||
        clipIdentity(previous.url) !== clipIdentity(sound.url))
    ) {
      buffers.delete(sound.id);
      loading.delete(sound.id);
    }
    customUrls.set(sound.id, {
      url: sound.url,
      volume: sound.volume,
      serverId,
    });
  }
}

/** The name a custom clip was saved under. Builtins use the locale tables. */
export function soundboardCustomName(soundId: string): string | null {
  return customNames.get(soundId) ?? null;
}

/** Test seam. A play's timer would otherwise outlive the assertion. */
export function resetSoundboardMarksForTests(): void {
  marks.clear();
  activeUntilById.clear();
}

export async function prefetchSoundboard(serverId: string): Promise<void> {
  const token = (catalogTokens.get(serverId) ?? 0) + 1;
  catalogTokens.set(serverId, token);
  try {
    const page = await fetchSoundboard(serverId);
    if (catalogTokens.get(serverId) === token) {
      rememberCustom(serverId, page.sounds);
    }
  } catch {
    // The board still plays the built-in pack.
  }
  await Promise.all(
    SOUNDBOARD_BUILTINS.map((sound) =>
      warm(`/sounds/soundboard/${sound.file}`, sound.id),
    ),
  );
}

/** Most decoded custom clips kept at once: one full board. Built-ins stay. */
const CUSTOM_BUFFER_MAX = 24;

function evictCustomBuffers(): void {
  const custom = [...buffers.keys()].filter((id) => customUrls.has(id));
  for (const id of custom.slice(0, Math.max(0, custom.length - CUSTOM_BUFFER_MAX))) {
    buffers.delete(id);
  }
}

function warm(url: string, id: string): Promise<AudioBuffer | null> {
  const cached = buffers.get(id);
  if (cached) {
    return Promise.resolve(cached);
  }
  const pending = loading.get(id);
  if (pending) {
    return pending;
  }
  const task = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const buffer = await decodeAudioBuffer(await response.arrayBuffer());
      if (buffer) {
        buffers.set(id, buffer);
        evictCustomBuffers();
      }
      return buffer;
    } catch {
      return null;
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, task);
  return task;
}

async function bufferFor(soundId: string): Promise<AudioBuffer | null> {
  const cached = buffers.get(soundId);
  if (cached) {
    return cached;
  }
  const builtin = soundboardBuiltin(soundId);
  if (builtin) {
    return warm(`/sounds/soundboard/${builtin.file}`, soundId);
  }
  const custom = customUrls.get(soundId);
  if (!custom) {
    return null;
  }
  return warm(custom.url, soundId);
}

function clampGain(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * One bus for every clip on this machine. Volume and mute write it live,
 * so a clip that is already sounding follows the slider. It does not pass
 * through the cue master: the soundboard slider must not turn message
 * sounds down with it.
 */
let bus: GainNode | null = null;
let busContext: AudioContext | null = null;

function soundboardLevel(): number {
  return soundboardMuted() ? 0 : soundboardListenerVolume();
}

function soundboardBus(): GainNode | null {
  const ctx = sharedAudioContext();
  if (!ctx) {
    return null;
  }
  if (!bus || busContext !== ctx) {
    bus = ctx.createGain();
    bus.gain.value = soundboardLevel();
    bus.connect(ctx.destination);
    busContext = ctx;
  }
  return bus;
}

function applySoundboardBus(): void {
  const node = soundboardBus();
  if (!node) {
    return;
  }
  // Assign it. A scheduled ramp leaves the clip at the gain it started with.
  node.gain.cancelScheduledValues(node.context.currentTime);
  node.gain.value = soundboardLevel();
}

function startSoundboardClip(buffer: AudioBuffer, soundVolume: number): AudioBufferSourceNode | null {
  const ctx = sharedAudioContext();
  const destination = soundboardBus();
  if (!ctx || !destination) {
    return null;
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const clip = ctx.createGain();
  clip.gain.value = clampGain(soundVolume);
  source.connect(clip);
  clip.connect(destination);
  source.start();
  source.stop(ctx.currentTime + SOUNDBOARD_MAX_DURATION_MS / 1000);
  return source;
}

const catalogRefresh = new Map<string, Promise<void>>();
const catalogRefreshAt = new Map<string, number>();

/** Pull a fresh catalog when a custom clip is missing or its URL has expired. */
async function refreshCustomCatalog(
  serverId: string,
  force: boolean,
): Promise<void> {
  const pending = catalogRefresh.get(serverId);
  if (pending) {
    await pending;
    if (!force) {
      return;
    }
  }
  const now = Date.now();
  if (!force && now - (catalogRefreshAt.get(serverId) ?? 0) < 4_000) {
    return;
  }
  catalogRefreshAt.set(serverId, now);
  const task = fetchSoundboard(serverId)
    .then((page) => {
      rememberCustom(serverId, page.sounds);
    })
    .catch(() => undefined)
    .finally(() => {
      catalogRefresh.delete(serverId);
    });
  catalogRefresh.set(serverId, task);
  await task;
}

/**
 * Play for this machine. A deafened listener passes `hear: false` and still
 * gets the float from `showSoundboardMark`. Mute and volume ride the bus,
 * so they cut a clip that is already playing. Clicks still go out.
 */
export async function playSoundboardClip(
  soundId: string,
  hear: boolean | (() => boolean),
): Promise<void> {
  // A function is asked again after the fetch and decode, so a listener who
  // deafened or left the call while the clip loaded does not hear it start.
  const mayHear = (): boolean => (typeof hear === "function" ? hear() : hear);
  if (!mayHear()) {
    return;
  }
  unlockSounds();
  let buffer = await bufferFor(soundId);
  if (!buffer && !soundboardBuiltin(soundId) && catalogServerId) {
    await refreshCustomCatalog(catalogServerId, !customUrls.has(soundId));
    buffer = await bufferFor(soundId);
  }
  if (!buffer || !mayHear()) {
    return;
  }
  startSoundboardClip(buffer, customUrls.get(soundId)?.volume ?? 1);
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
    previewNode = startSoundboardClip(
      buffer,
      customUrls.get(soundId)?.volume ?? 1,
    );
  })();
}

export function showSoundboardMark(mark: Omit<SoundboardMark, "until">): void {
  const until = Date.now() + MARK_MS;
  marks.set(mark.userId, { ...mark, until });
  lightSound(mark.soundId, until);
  notify();
  globalThis.setTimeout(() => {
    const current = marks.get(mark.userId);
    if (current && current.until === until) {
      marks.delete(mark.userId);
    }
    clearSound(mark.soundId, until);
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

export function useSoundboardActiveIds(): ReadonlySet<string> {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  const now = Date.now();
  const ids = new Set<string>();
  for (const [id, until] of activeUntilById) {
    if (until > now) {
      ids.add(id);
    }
  }
  return ids;
}

function lightSound(soundId: string, until: number): void {
  const current = activeUntilById.get(soundId) ?? 0;
  if (until > current) {
    activeUntilById.set(soundId, until);
  }
}

function clearSound(soundId: string, until: number): void {
  if (activeUntilById.get(soundId) === until) {
    activeUntilById.delete(soundId);
  }
}

/** Light up the tile the moment you click, without waiting for the room echo. */
export function pulseSoundboardActive(soundId: string): void {
  const until = Date.now() + MARK_MS;
  lightSound(soundId, until);
  notify();
  window.setTimeout(() => {
    clearSound(soundId, until);
    notify();
  }, MARK_MS);
}

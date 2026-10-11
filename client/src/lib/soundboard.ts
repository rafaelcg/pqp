import {
  soundboardBuiltin,
  SOUNDBOARD_BUILTINS,
  SOUNDBOARD_MAX_DURATION_MS,
  SOUNDBOARD_MAX_SOUNDS,
  SOUNDBOARD_PLAY_BURST,
  SOUNDBOARD_PLAY_REFILL_MS,
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
const MUTED_USERS_KEY = "pqp:soundboard-muted-users";
/** A mark lasts as long as its clip, and never less than this or more than the cap. */
const MARK_MIN_MS = 1200;
/** What a custom clip not in the catalog yet is assumed to last, until it is. */
const MARK_FALLBACK_MS = 2200;
/** Most people kept in the "no soundboard from them" list. The newest win. */
const MUTED_USERS_MAX = 500;
/** How stale the catalog may be before a custom clip's play pulls it again. */
const PLAY_REFRESH_GAP_MS = 15_000;
/**
 * How long a click waits for the room's echo before it counts as refused.
 * The server answers a refusal with silence (a full room, your own cap, a
 * moderator mute), so the echo is the only proof a clip went out. Long
 * enough that a slow phone connection is not told a clip that went out did
 * not play.
 */
const ECHO_WAIT_MS = 3000;
/** How long "that one did not play" stays on the panel. */
const REFUSED_SHOW_MS = 3000;

const buffers = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<AudioBuffer | null>>();
const customUrls = new Map<
  string,
  { url: string; volume: number; serverId: string }
>();
const customNames = new Map<string, string>();
const customDurations = new Map<string, number>();

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

/** A click that has gone out and is waiting for the room's echo. */
interface PendingPlay {
  token: number;
  /** When it was sent: the earliest the server can have admitted it. */
  sentAt: number;
}

/** Clicks still waiting for their echo, per sound. */
const pendingById = new Map<string, PendingPlay[]>();
let pendingSeq = 0;
let refusedUntil = 0;
let refusedKind: "refused" | "removed" = "refused";

/**
 * How many of one person's own clips may sound at once in a room. This is
 * `SOUNDBOARD_USER_CONCURRENCY` in `server/src/ws/soundboard.ts`, which this
 * package cannot import. Change both together.
 */
const OWN_CONCURRENCY = 3;

/** This person's echoed plays in the room, as when each one stops sounding. */
let ownPlayEnds: number[] = [];

function ownClipDurationMs(soundId: string): number | null {
  return soundboardBuiltin(soundId)?.durationMs ?? customDurations.get(soundId) ?? null;
}

/**
 * True when `OWN_CONCURRENCY` of this person's own clips are still sounding.
 * The server refuses the next one in silence, so the click is refused here
 * and told at once. The clock starts at the click, not at the echo: the
 * server admitted the play somewhere in between, so this can only run early,
 * and the echo wait still catches a refusal this cannot predict.
 */
function ownClipsFull(now: number): boolean {
  ownPlayEnds = ownPlayEnds.filter((end) => end > now);
  return ownPlayEnds.length >= OWN_CONCURRENCY;
}

/**
 * A local copy of the server's play budget (`takePlayToken` in
 * `server/src/ws/soundboard.ts`), in front of the socket. Holding Enter on a
 * tile repeats about thirty times a second, which spends the socket's whole
 * frame budget and gets it closed, and the server would refuse all of those
 * plays anyway. So they are never sent, and the person is told at once.
 * Keep it the same arithmetic as the server's, step for step.
 */
const SEND_BURST = SOUNDBOARD_PLAY_BURST;
const SEND_REFILL_MS = SOUNDBOARD_PLAY_REFILL_MS;
let sendTokens = SEND_BURST;
let sendRefilledAt = 0;

function takeSendToken(now: number): boolean {
  const earned = Math.floor((now - sendRefilledAt) / SEND_REFILL_MS);
  if (earned > 0) {
    sendTokens = Math.min(SEND_BURST, sendTokens + earned);
    sendRefilledAt += earned * SEND_REFILL_MS;
  }
  if (sendTokens >= SEND_BURST) {
    // A full bucket banks no time: the next refill counts from now.
    sendRefilledAt = now;
  }
  if (sendTokens <= 0) {
    return false;
  }
  sendTokens -= 1;
  return true;
}

function flagRefused(kind: "refused" | "removed"): void {
  refusedKind = kind;
  refusedUntil = Date.now() + REFUSED_SHOW_MS;
  notify();
  globalThis.setTimeout(notify, REFUSED_SHOW_MS);
}

/**
 * A click that was never echoed. A custom clip may have been deleted by
 * somebody else: pull the catalog, and if it is gone say so instead of
 * "try again", which would never help.
 */
async function explainRefusal(soundId: string): Promise<void> {
  if (!soundboardBuiltin(soundId) && catalogServerId) {
    await refreshCustomCatalog(catalogServerId, true);
    if (!customNames.has(soundId)) {
      flagRefused("removed");
      return;
    }
  }
  flagRefused("refused");
}

/**
 * Send a play. The tile lights when the room's echo comes back
 * (`noteOwnSoundboardEcho`), not on the click, so a refused click never looks
 * like it played. No echo in `ECHO_WAIT_MS` flags it as refused.
 */
export function requestSoundboardPlay(soundId: string): void {
  if (!sender) {
    return;
  }
  const now = Date.now();
  // The overlap cap is asked first and spends nothing, as on the server.
  if (ownClipsFull(now) || !takeSendToken(now)) {
    flagRefused("refused");
    return;
  }
  sender(soundId);
  const token = ++pendingSeq;
  const list = pendingById.get(soundId) ?? [];
  list.push({ token, sentAt: now });
  pendingById.set(soundId, list);
  globalThis.setTimeout(() => {
    const current = pendingById.get(soundId);
    const index = current?.findIndex((entry) => entry.token === token) ?? -1;
    if (!current || index < 0) {
      return;
    }
    current.splice(index, 1);
    if (current.length === 0) {
      pendingById.delete(soundId);
    }
    void explainRefusal(soundId);
  }, ECHO_WAIT_MS);
}

/** The room echoed one of this person's own plays: it went out. */
export function noteOwnSoundboardEcho(soundId: string): void {
  const list = pendingById.get(soundId);
  const sentAt = list?.shift()?.sentAt ?? Date.now();
  if (list && list.length === 0) {
    pendingById.delete(soundId);
  }
  const duration = ownClipDurationMs(soundId);
  if (duration !== null) {
    ownPlayEnds.push(sentAt + duration);
  }
  if (refusedUntil !== 0) {
    refusedUntil = 0;
    notify();
  }
}

/**
 * For a few seconds after one of this person's clicks went unanswered: why.
 * Null the rest of the time.
 */
export function useSoundboardRefused(): "refused" | "removed" | null {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  return refusedUntil > Date.now() ? refusedKind : null;
}

/** Test seam. */
export function resetSoundboardPendingForTests(): void {
  pendingById.clear();
  ownPlayEnds = [];
  refusedUntil = 0;
  sendTokens = SEND_BURST;
  sendRefilledAt = 0;
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

/**
 * People whose clips this machine does not play or mark. Discord has only
 * the one global slider; muting the one person who will not stop is the
 * thing its users keep asking for. Local, like every listener setting.
 */
let mutedUsersCache: Set<string> | null = null;

function mutedUsers(): Set<string> {
  if (mutedUsersCache) {
    return mutedUsersCache;
  }
  let ids: string[] = [];
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(MUTED_USERS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    ids = [];
  }
  mutedUsersCache = new Set(ids);
  return mutedUsersCache;
}

export function isSoundboardUserMuted(userId: string): boolean {
  return mutedUsers().has(userId);
}

export function setSoundboardUserMuted(userId: string, muted: boolean): void {
  const next = new Set(mutedUsers());
  // Delete before add so a person muted again moves to the end: the list is
  // pruned from the front, and the newest mutes are the ones that matter.
  next.delete(userId);
  if (muted) {
    next.add(userId);
  }
  mutedUsersCache = pruneMutedUsers(next);
  try {
    localStorage.setItem(MUTED_USERS_KEY, JSON.stringify([...mutedUsersCache]));
  } catch {
    // Private mode: the mute holds for this page only.
  }
  if (muted) {
    silenceSoundboardUser(userId);
  }
  notify();
}

function pruneMutedUsers(ids: Set<string>): Set<string> {
  if (ids.size <= MUTED_USERS_MAX) {
    return ids;
  }
  return new Set([...ids].slice(ids.size - MUTED_USERS_MAX));
}

/**
 * Another tab of this account changed a soundboard setting. The cache and the
 * bus are per page, so without this a mute made in one tab left the other
 * tab playing the person, at the old volume, until it was reloaded.
 */
function onStorage(event: StorageEvent): void {
  if (event.key === null) {
    // localStorage.clear() in another tab: every setting is back to its default.
    mutedUsersCache = null;
    applySoundboardBus(true);
    notify();
    return;
  }
  if (event.key === MUTED_USERS_KEY) {
    const before = mutedUsers();
    mutedUsersCache = null;
    const after = mutedUsers();
    for (const id of after) {
      if (!before.has(id)) {
        silenceSoundboardUser(id);
      }
    }
    notify();
    return;
  }
  if (event.key === VOLUME_KEY || event.key === MUTE_KEY) {
    applySoundboardBus(true);
    notify();
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", onStorage);
}

export function useSoundboardUserMuted(
  userId: string | undefined,
): [boolean, (muted: boolean) => void] {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  return [
    userId ? isSoundboardUserMuted(userId) : false,
    (muted) => {
      if (userId) {
        setSoundboardUserMuted(userId, muted);
      }
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

const CUSTOM_CLEAR_GRACE_MS = 30_000;
let customClearTimer: ReturnType<typeof setTimeout> | null = null;

/** The call this machine is in. Plays for that server can refresh the catalog. */
export function setSoundboardCatalogServer(serverId: string | null): void {
  catalogServerId = serverId;
  // Entering another server's call drops the previous server's custom clips
  // and their decoded audio, so playing across servers keeps at most one
  // board in memory. A null (the control unmounting) keeps what it has for a
  // moment, since the same call may remount it, then lets go of the decoded
  // audio if no call has taken over.
  if (customClearTimer) {
    clearTimeout(customClearTimer);
    customClearTimer = null;
  }
  if (serverId === null) {
    customClearTimer = setTimeout(() => {
      customClearTimer = null;
      if (catalogServerId !== null) {
        return;
      }
      for (const id of [...customUrls.keys()]) {
        customUrls.delete(id);
        customNames.delete(id);
        customDurations.delete(id);
        buffers.delete(id);
        loading.delete(id);
      }
    }, CUSTOM_CLEAR_GRACE_MS);
    return;
  }
  for (const id of [...catalogs.keys()]) {
    if (id !== serverId) {
      catalogs.delete(id);
    }
  }
  for (const [id, row] of customUrls) {
    if (row.serverId === serverId) {
      continue;
    }
    customUrls.delete(id);
    customNames.delete(id);
    customDurations.delete(id);
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
  // Marks and floats read the names from here.
  notify();
}

function clipIdentity(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** The last list each server answered, for the panel. Notified on change. */
const catalogs = new Map<
  string,
  { sounds: readonly SoundboardSound[]; maxSounds: number; slotsUsed: number }
>();

export interface SoundboardCatalog {
  sounds: readonly SoundboardSound[];
  maxSounds: number;
  slotsUsed: number;
}

/**
 * The panel's view of a server's custom clips. Every fetch updates it, so a
 * clip somebody else added, renamed or deleted shows up as soon as anything
 * on this machine asks again (opening the panel, a play of an unknown clip,
 * a click that was never echoed).
 */
export function useSoundboardCatalog(serverId: string | null): SoundboardCatalog | null {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump((n) => n + 1)), []);
  return serverId ? (catalogs.get(serverId) ?? null) : null;
}

/** Ask the server for the list again, at most once per couple of seconds. */
export function refreshSoundboardCatalog(serverId: string): Promise<void> {
  return refreshCustomCatalog(serverId, false, 2_000);
}

function rememberCatalog(
  serverId: string,
  page: { sounds: readonly SoundboardSound[]; maxSounds: number; slotsUsed?: number },
): void {
  catalogs.set(serverId, {
    sounds: page.sounds,
    maxSounds: page.maxSounds,
    slotsUsed: page.slotsUsed ?? page.sounds.length,
  });
  rememberCustom(serverId, page.sounds);
  notify();
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
    customDurations.delete(id);
    buffers.delete(id);
    loading.delete(id);
  }
  for (const sound of sounds) {
    customNames.set(sound.id, sound.name);
    customDurations.set(sound.id, sound.durationMs);
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
      rememberCatalog(serverId, page);
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
const CUSTOM_BUFFER_MAX = SOUNDBOARD_MAX_SOUNDS;

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
  // A server switch drops the entry from `loading`; a load that finishes
  // after that must not put its buffer back, or it escapes the custom cap.
  let task: Promise<AudioBuffer | null> | null = null;
  task = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const buffer = await decodeAudioBuffer(await response.arrayBuffer());
      if (buffer && loading.get(id) === task) {
        buffers.set(id, buffer);
        evictCustomBuffers();
      }
      return buffer;
    } catch {
      return null;
    } finally {
      if (loading.get(id) === task) {
        loading.delete(id);
      }
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

function applySoundboardBus(onlyIfBuilt = false): void {
  // A storage event from another tab must not start audio in a tab that has
  // none: a bus built later reads the current level when it is made.
  if (onlyIfBuilt && !bus) {
    return;
  }
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

/**
 * Clips sounding in the call, with who played each, so leaving the call can
 * cut them all and muting a person can cut theirs. Previews are separate.
 */
const roomSources = new Map<AudioBufferSourceNode, string | null>();

function stopSources(match?: (userId: string | null) => boolean): void {
  for (const [source, userId] of [...roomSources]) {
    if (match && !match(userId)) {
      continue;
    }
    try {
      source.stop();
    } catch {
      // Already finished.
    }
    roomSources.delete(source);
  }
}

/**
 * Stop every clip from the call. Leaving or switching rooms used to let a
 * clip from the old room play on for seconds after the hangup.
 */
export function stopSoundboardClips(): void {
  // The overlap count is per room, and leaving one ends its clips here.
  ownPlayEnds = [];
  stopSources();
}

/**
 * Cut what is sounding without leaving: the listener deafened. The overlap
 * count is left alone, because the server still counts those clips as the
 * players' own, and deafening ends nothing for them.
 */
export function silenceSoundboardClips(): void {
  stopSources();
}

/** Stop one person's sounding clips and take down their mark. */
function silenceSoundboardUser(userId: string): void {
  stopSources((from) => from === userId);
  const mark = marks.get(userId);
  if (mark) {
    marks.delete(userId);
    clearSound(mark.soundId, mark.until);
  }
}

const catalogRefresh = new Map<string, Promise<void>>();
const catalogRefreshAt = new Map<string, number>();

/** Pull a fresh catalog when a custom clip is missing or its URL has expired. */
async function refreshCustomCatalog(
  serverId: string,
  force: boolean,
  minGapMs = 4_000,
): Promise<void> {
  const pending = catalogRefresh.get(serverId);
  if (pending) {
    // The refresh in flight is as fresh as another one would be.
    await pending;
    return;
  }
  const now = Date.now();
  if (!force && now - (catalogRefreshAt.get(serverId) ?? 0) < minGapMs) {
    return;
  }
  catalogRefreshAt.set(serverId, now);
  const task = fetchSoundboard(serverId)
    .then((page) => {
      rememberCatalog(serverId, page);
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
  fromUserId?: string,
): Promise<void> {
  // A function is asked again after the fetch and decode, so a listener who
  // deafened or left the call while the clip loaded does not hear it start.
  // So is the per-person mute: it can land while the clip loads.
  const mayHear = (): boolean =>
    (typeof hear === "function" ? hear() : hear) &&
    !(fromUserId !== undefined && isSoundboardUserMuted(fromUserId));
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
  const source = startSoundboardClip(buffer, customUrls.get(soundId)?.volume ?? 1);
  if (source) {
    roomSources.set(source, fromUserId ?? null);
    source.addEventListener?.("ended", () => roomSources.delete(source));
  }
}

let previewNode: AudioBufferSourceNode | null = null;
let previewSeq = 0;

/** Stop whatever preview is playing (closing the add dialog, leaving settings). */
export function stopSoundboardPreview(): void {
  stopPreview();
}

function stopPreview(): void {
  previewSeq += 1;
  if (previewNode) {
    try {
      previewNode.stop();
    } catch {
      // Already finished.
    }
    previewNode = null;
  }
}

/** Local preview. Does not tell the room. A new preview stops the last one. */
export function previewSoundboardClip(soundId: string): void {
  stopPreview();
  // Only the newest click may start: four quick clicks used to load
  // together and then all play at once.
  const seq = previewSeq;
  void (async () => {
    unlockSounds();
    const buffer = await bufferFor(soundId);
    if (!buffer || seq !== previewSeq) {
      return;
    }
    previewNode = startSoundboardClip(
      buffer,
      customUrls.get(soundId)?.volume ?? 1,
    );
  })();
}

/**
 * How long a play stays marked: as long as the clip sounds. A built-in's
 * length is known; a custom clip's comes with the catalog. A clip this
 * machine has not heard of yet gets a short guess, corrected once the
 * catalog arrives.
 */
function markDurationMs(soundId: string): number {
  const known = soundboardBuiltin(soundId)?.durationMs ?? customDurations.get(soundId);
  return Math.min(
    SOUNDBOARD_MAX_DURATION_MS,
    Math.max(MARK_MIN_MS, known ?? MARK_FALLBACK_MS),
  );
}

function scheduleMark(mark: SoundboardMark): void {
  marks.set(mark.userId, mark);
  lightSound(mark.soundId, mark.until);
  notify();
  globalThis.setTimeout(
    () => {
      const current = marks.get(mark.userId);
      if (current && current.until === mark.until) {
        marks.delete(mark.userId);
      }
      clearSound(mark.soundId, mark.until);
      notify();
    },
    Math.max(0, mark.until - Date.now()),
  );
}

export function showSoundboardMark(mark: Omit<SoundboardMark, "until">): void {
  const startedAt = Date.now();
  const shown: SoundboardMark = {
    ...mark,
    until: startedAt + markDurationMs(mark.soundId),
  };
  scheduleMark(shown);
  if (soundboardBuiltin(mark.soundId) || !catalogServerId) {
    return;
  }
  // A custom clip: this machine's copy of its name and length may be old
  // (renamed, or new since the call began). Pull the list in the background,
  // not more often than every few seconds, and then fix the mark.
  void refreshCustomCatalog(catalogServerId, false, PLAY_REFRESH_GAP_MS).then(() => {
    const current = marks.get(mark.userId);
    if (!current || current.until !== shown.until || current.soundId !== mark.soundId) {
      return;
    }
    const until = startedAt + markDurationMs(mark.soundId);
    if (until === shown.until) {
      return;
    }
    clearSound(shown.soundId, shown.until);
    scheduleMark({ ...shown, until });
  });
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

/**
 * Preview a file that is not on the board yet (the add dialog). Same rules
 * as a stored clip's preview: through the board's bus, so the board's mute
 * and volume apply, and a new preview stops the last one.
 */
export function previewSoundboardBuffer(buffer: AudioBuffer, volume = 1): void {
  unlockSounds();
  stopPreview();
  previewNode = startSoundboardClip(buffer, volume);
}

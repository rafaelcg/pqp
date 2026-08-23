/**
 * In-app sound cues: message ping, mention, voice join/leave, incoming/outgoing call.
 *
 * Own long-lived AudioContext. Do not reuse `voice-audio.ts`: that context
 * closes when the last speaking-meter ref drops, which would kill a ringtone
 * mid-call.
 *
 * Desktop banners stay silent (`Notification.silent`). These cues are the
 * audible half, and they run even when the user has not opted into OS
 * notifications. DND and per-channel levels still gate whether we play.
 */

import type { SoundPreferences } from "@pqp/shared";
import { queuePreferenceSync } from "@/lib/preferences";

export const SOUND_STORAGE_KEY = "pqp-sounds";

export type SoundCue =
  | "message"
  | "mention"
  | "voiceJoin"
  | "voiceLeave"
  | "incomingCall"
  | "outgoingCall";

type SampleCue = "message" | "mention" | "voiceJoin" | "voiceLeave";

export interface SoundState {
  enabled: boolean;
  message: boolean;
  mention: boolean;
  voiceJoin: boolean;
  voiceLeave: boolean;
  incomingCall: boolean;
  outgoingCall: boolean;
}

const DEFAULT_STATE: SoundState = {
  enabled: true,
  message: true,
  mention: true,
  voiceJoin: true,
  voiceLeave: true,
  incomingCall: true,
  outgoingCall: true,
};

const SAMPLE_URLS: Record<SampleCue, readonly string[]> = {
  // mp3 first: Safari still prefers it over Opus-in-Ogg.
  message: ["/sounds/message.mp3", "/sounds/message.ogg"],
  mention: ["/sounds/mention.mp3", "/sounds/mention.ogg"],
  voiceJoin: ["/sounds/voice-join.mp3", "/sounds/voice-join.ogg"],
  voiceLeave: ["/sounds/voice-leave.mp3", "/sounds/voice-leave.ogg"],
};

type OutputContext = AudioContext & {
  setSinkId?: (id: string) => Promise<void>;
};

let state: SoundState = load();
const listeners = new Set<() => void>();

let context: OutputContext | null = null;
let master: GainNode | null = null;
let outputDeviceId = "";
let outputVolume = 1;
const buffers = new Map<SampleCue, AudioBuffer>();
const loops = new Map<"incomingCall" | "outgoingCall", () => void>();

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

function readState(value: unknown): SoundState {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_STATE };
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: isBoolean(record.enabled) ? record.enabled : DEFAULT_STATE.enabled,
    message: isBoolean(record.message) ? record.message : DEFAULT_STATE.message,
    mention: isBoolean(record.mention) ? record.mention : DEFAULT_STATE.mention,
    voiceJoin: isBoolean(record.voiceJoin)
      ? record.voiceJoin
      : DEFAULT_STATE.voiceJoin,
    voiceLeave: isBoolean(record.voiceLeave)
      ? record.voiceLeave
      : DEFAULT_STATE.voiceLeave,
    incomingCall: isBoolean(record.incomingCall)
      ? record.incomingCall
      : DEFAULT_STATE.incomingCall,
    outgoingCall: isBoolean(record.outgoingCall)
      ? record.outgoingCall
      : DEFAULT_STATE.outgoingCall,
  };
}

function load(): SoundState {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_STATE };
    }
    return readState(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function persist(next: SoundState): void {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode. The in-memory copy still drives this session.
  }
}

function toPreferences(current: SoundState): SoundPreferences {
  return {
    enabled: current.enabled,
    message: current.message,
    mention: current.mention,
    voiceJoin: current.voiceJoin,
    voiceLeave: current.voiceLeave,
    incomingCall: current.incomingCall,
    outgoingCall: current.outgoingCall,
  };
}

function commit(next: SoundState, { sync }: { sync: boolean }): void {
  state = next;
  persist(next);
  if (sync) {
    queuePreferenceSync({ sounds: toPreferences(next) }, { immediate: true });
  }
  for (const listener of listeners) {
    listener();
  }
}

export function getSoundState(): SoundState {
  return state;
}

export function subscribeSounds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSoundEnabled(enabled: boolean): void {
  commit({ ...state, enabled }, { sync: true });
  if (!enabled) {
    stopAllSoundLoops();
  }
}

export function setSoundCueEnabled(cue: SoundCue, enabled: boolean): void {
  commit({ ...state, [cue]: enabled }, { sync: true });
  if (!enabled && (cue === "incomingCall" || cue === "outgoingCall")) {
    stopSoundLoop(cue);
  }
}

/**
 * Account copy from `/api/me`. Does not write back: these values came from
 * the server, so echoing them would let a stale tab undo a choice made on
 * another device.
 */
export function adoptSoundPreferences(
  preferences: SoundPreferences | undefined,
): void {
  if (!preferences) {
    return;
  }
  commit(readState({ ...state, ...preferences }), { sync: false });
}

export function cueForActivity(mentions: number): "message" | "mention" {
  return mentions > 0 ? "mention" : "message";
}

export function isCueEnabled(current: SoundState, cue: SoundCue): boolean {
  if (!current.enabled) {
    return false;
  }
  return current[cue];
}

function ensureContext(): OutputContext | null {
  if (typeof AudioContext === "undefined") {
    return null;
  }
  if (!context || context.state === "closed") {
    context = new AudioContext() as OutputContext;
    master = context.createGain();
    master.gain.value = outputVolume;
    master.connect(context.destination);
    if (outputDeviceId && typeof context.setSinkId === "function") {
      void context.setSinkId(outputDeviceId).catch(() => {});
    }
  }
  return context;
}

/** Resume after a user gesture so later cues (and a ringtone on a cold tab) can play. */
export function unlockSounds(): void {
  const ctx = ensureContext();
  if (ctx && ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  prefetchSampleBytes();
  if (ctx) {
    void warmupBuffers(ctx);
  }
}

export function setSoundOutput(options: {
  deviceId: string;
  volume: number;
}): void {
  outputDeviceId = options.deviceId;
  outputVolume = Math.min(1, Math.max(0, options.volume));
  if (master) {
    master.gain.value = outputVolume;
  }
  if (context && typeof context.setSinkId === "function") {
    void context.setSinkId(outputDeviceId || "").catch(() => {});
  }
}

const SAMPLE_CUES = Object.keys(SAMPLE_URLS) as SampleCue[];

const fetchedBytes = new Map<SampleCue, Promise<ArrayBuffer | null>>();
const decoding = new Map<SampleCue, Promise<AudioBuffer | null>>();
let cacheGeneration = 0;

async function fetchSampleBytes(cue: SampleCue): Promise<ArrayBuffer | null> {
  for (const url of SAMPLE_URLS[cue]) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      return await response.arrayBuffer();
    } catch {
      // Try the next container. Safari in particular prefers mp3 over opus.
    }
  }
  return null;
}

function prefetchSampleBytes(): void {
  for (const cue of SAMPLE_CUES) {
    if (fetchedBytes.has(cue)) {
      continue;
    }
    const generation = cacheGeneration;
    fetchedBytes.set(
      cue,
      fetchSampleBytes(cue).then((bytes) =>
        generation === cacheGeneration ? bytes : null,
      ),
    );
  }
}

async function loadBuffer(
  ctx: AudioContext,
  cue: SampleCue,
): Promise<AudioBuffer | null> {
  const cached = buffers.get(cue);
  if (cached) {
    return cached;
  }
  const inflight = decoding.get(cue);
  if (inflight) {
    return inflight;
  }
  const generation = cacheGeneration;
  const task = (async () => {
    prefetchSampleBytes();
    const bytes = await fetchedBytes.get(cue);
    if (!bytes || generation !== cacheGeneration) {
      return null;
    }
    try {
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      if (generation !== cacheGeneration) {
        return null;
      }
      buffers.set(cue, buffer);
      return buffer;
    } catch {
      return null;
    }
  })();
  decoding.set(cue, task);
  try {
    return await task;
  } finally {
    decoding.delete(cue);
  }
}

async function warmupBuffers(ctx: AudioContext): Promise<void> {
  await Promise.all(SAMPLE_CUES.map((cue) => loadBuffer(ctx, cue)));
}

let sampleBusy = false;
let currentCue: SampleCue | null = null;
let pendingCue: SampleCue | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let playGeneration = 0;
let finishedGeneration = 0;
let sampleWatchdog: ReturnType<typeof setTimeout> | null = null;
const sampleIdleWaiters: Array<() => void> = [];
const CUE_SETTLE_CAP_MS = 750;

function notifySampleIdle(): void {
  if (sampleBusy) {
    return;
  }
  const waiters = sampleIdleWaiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
}

function whenSamplesIdle(): Promise<void> {
  if (!sampleBusy) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    sampleIdleWaiters.push(resolve);
  });
}

function clearSampleWatchdog(): void {
  if (sampleWatchdog !== null) {
    clearTimeout(sampleWatchdog);
    sampleWatchdog = null;
  }
}

function finishSample(generation: number): void {
  if (generation !== playGeneration || generation === finishedGeneration) {
    return;
  }
  finishedGeneration = generation;
  clearSampleWatchdog();
  currentSource = null;
  currentCue = null;
  sampleBusy = false;
  if (pendingCue) {
    const next = pendingCue;
    pendingCue = null;
    enqueueSample(next);
    return;
  }
  notifySampleIdle();
}

function enqueueSample(cue: SampleCue): void {
  if (sampleBusy && currentCue === cue) {
    return;
  }
  if (sampleBusy) {
    pendingCue = cue;
    return;
  }
  sampleBusy = true;
  currentCue = cue;
  void startSample(cue);
}

async function startSample(cue: SampleCue): Promise<void> {
  const generation = ++playGeneration;
  const ctx = ensureContext();
  if (!ctx || !master) {
    finishSample(generation);
    return;
  }
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => {});
  }
  if (generation !== playGeneration) {
    return;
  }
  const buffer = await loadBuffer(ctx, cue);
  if (generation !== playGeneration) {
    return;
  }
  if (!buffer || !master) {
    finishSample(generation);
    return;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(master);
  source.onended = () => {
    if (currentSource !== source) {
      return;
    }
    finishSample(generation);
  };
  currentSource = source;
  try {
    source.start();
  } catch {
    finishSample(generation);
    return;
  }
  // If onended never fires (context stuck suspended), free the queue so
  // later cues and the outgoing ring are not blocked forever.
  const waitMs = Math.ceil((buffer.duration + 0.08) * 1000);
  sampleWatchdog = setTimeout(() => {
    sampleWatchdog = null;
    finishSample(generation);
  }, waitMs);
}

/** Resolves when the current one-shot has ended, or after a short cap. */
export function whenCueSettled(): Promise<void> {
  if (!sampleBusy) {
    return Promise.resolve();
  }
  return Promise.race([
    whenSamplesIdle(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, CUE_SETTLE_CAP_MS);
    }),
  ]);
}

/**
 * Dual-tone telephone cadence. Incoming is the classic 440+480 Hz US ring
 * (2s on, 4s period). Outgoing is quieter and a hair slower so you can tell
 * which side of the call you are on without looking.
 */
function stopRunningLoop(cue: "incomingCall" | "outgoingCall"): void {
  const stop = loops.get(cue);
  if (!stop) {
    return;
  }
  loops.delete(cue);
  stop();
}

function startToneLoop(cue: "incomingCall" | "outgoingCall"): void {
  stopRunningLoop(cue);
  const ctx = ensureContext();
  if (!ctx || !master) {
    return;
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }

  const incoming = cue === "incomingCall";
  const freqA = incoming ? 440 : 425;
  const freqB = incoming ? 480 : 450;
  const level = incoming ? 0.22 : 0.12;
  const onSeconds = incoming ? 2 : 1.6;
  const periodMs = incoming ? 4000 : 5000;
  const active: OscillatorNode[] = [];

  const burst = () => {
    if (!context || context.state === "closed" || !master) {
      return;
    }
    const when = context.currentTime;
    const env = context.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(level, when + 0.02);
    env.gain.setValueAtTime(level, when + onSeconds - 0.04);
    env.gain.linearRampToValueAtTime(0, when + onSeconds);
    env.connect(master);

    for (const freq of [freqA, freqB]) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(env);
      osc.start(when);
      osc.stop(when + onSeconds + 0.02);
      active.push(osc);
      osc.onended = () => {
        const index = active.indexOf(osc);
        if (index >= 0) {
          active.splice(index, 1);
        }
      };
    }
  };

  burst();
  const timer = setInterval(burst, periodMs);
  loops.set(cue, () => {
    clearInterval(timer);
    for (const osc of active) {
      try {
        osc.stop();
      } catch {
        // Already stopped.
      }
    }
    active.length = 0;
  });
}

export function playCue(cue: SoundCue): void {
  if (!isCueEnabled(state, cue)) {
    return;
  }
  unlockSounds();
  if (cue === "incomingCall" || cue === "outgoingCall") {
    // Preview: one burst, not a loop.
    startToneLoop(cue);
    const delay = cue === "incomingCall" ? 2100 : 1700;
    if (typeof window !== "undefined") {
      window.setTimeout(() => stopSoundLoop(cue), delay);
    }
    return;
  }
  enqueueSample(cue);
}

export function playActivitySound(mentions: number): void {
  if (mentions <= 0) {
    return;
  }
  playCue("mention");
}

const loopTokens: Record<"incomingCall" | "outgoingCall", number> = {
  incomingCall: 0,
  outgoingCall: 0,
};

export function startSoundLoop(cue: "incomingCall" | "outgoingCall"): void {
  if (!isCueEnabled(state, cue)) {
    stopSoundLoop(cue);
    return;
  }
  unlockSounds();
  const other = cue === "incomingCall" ? "outgoingCall" : "incomingCall";
  stopSoundLoop(other);
  const token = ++loopTokens[cue];
  const start = () => {
    if (token !== loopTokens[cue]) {
      return;
    }
    if (!isCueEnabled(state, cue)) {
      return;
    }
    startToneLoop(cue);
  };
  if (!sampleBusy) {
    start();
    return;
  }
  void whenSamplesIdle().then(start);
}

export function stopSoundLoop(cue: "incomingCall" | "outgoingCall"): void {
  loopTokens[cue]++;
  stopRunningLoop(cue);
}

export function stopAllSoundLoops(): void {
  stopSoundLoop("incomingCall");
  stopSoundLoop("outgoingCall");
}

if (typeof window !== "undefined") {
  prefetchSampleBytes();
  const unlock = () => unlockSounds();
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
}

/** Test seam: drop buffers, loops, and the context without touching prefs. */
export function resetSoundEngineForTests(): void {
  playGeneration++;
  finishedGeneration = playGeneration;
  cacheGeneration++;
  loopTokens.incomingCall++;
  loopTokens.outgoingCall++;
  pendingCue = null;
  currentCue = null;
  sampleBusy = false;
  clearSampleWatchdog();
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch {
      // Already stopped.
    }
    currentSource = null;
  }
  sampleIdleWaiters.length = 0;
  stopAllSoundLoops();
  buffers.clear();
  decoding.clear();
  fetchedBytes.clear();
  if (context && context.state !== "closed") {
    void context.close().catch(() => {});
  }
  context = null;
  master = null;
}

export function resetSoundStateForTests(): void {
  resetSoundEngineForTests();
  state = { ...DEFAULT_STATE };
  listeners.clear();
}

/** Visible to tests: whether a loop is currently scheduled. */
export function soundLoopIsRunningForTests(
  cue: "incomingCall" | "outgoingCall",
): boolean {
  return loops.has(cue);
}

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

/** Incoming ringtones. Device-local: not part of the account sound prefs. */
export const INCOMING_RING_IDS = [
  "classic",
  "chime",
  "pulse",
  "marimba",
  "glass",
] as const;

export type IncomingRingId = (typeof INCOMING_RING_IDS)[number];

const DEFAULT_INCOMING_RING: IncomingRingId = "classic";

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

let incomingRing: IncomingRingId = DEFAULT_INCOMING_RING;
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

export function isIncomingRingId(value: unknown): value is IncomingRingId {
  return (
    typeof value === "string" &&
    (INCOMING_RING_IDS as readonly string[]).includes(value)
  );
}

function readIncomingRing(value: unknown): IncomingRingId {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_INCOMING_RING;
  }
  const id = (value as Record<string, unknown>).incomingRing;
  return isIncomingRingId(id) ? id : DEFAULT_INCOMING_RING;
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
      incomingRing = DEFAULT_INCOMING_RING;
      return { ...DEFAULT_STATE };
    }
    const parsed = JSON.parse(raw) as unknown;
    incomingRing = readIncomingRing(parsed);
    return readState(parsed);
  } catch {
    incomingRing = DEFAULT_INCOMING_RING;
    return { ...DEFAULT_STATE };
  }
}

function persist(next: SoundState): void {
  try {
    localStorage.setItem(
      SOUND_STORAGE_KEY,
      JSON.stringify({ ...next, incomingRing }),
    );
  } catch {
    // Quota or private mode. The in-memory copy still drives this session.
  }
}

function notifySoundListeners(): void {
  for (const listener of listeners) {
    listener();
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
  notifySoundListeners();
}

export function getIncomingRing(): IncomingRingId {
  return incomingRing;
}

export function setIncomingRing(id: IncomingRingId): void {
  incomingRing = id;
  persist(state);
  notifySoundListeners();
  if (loops.has("incomingCall")) {
    startToneLoop("incomingCall");
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
 * Incoming rings are short motifs, not a long dual-tone, except Classic
 * which is the original US telephone cadence. Outgoing stays a quieter,
 * slower dual-tone so you can tell which side of the call you are on.
 */
interface RingTone {
  freq: number;
  type: OscillatorType;
  delay: number;
  duration: number;
  peak: number;
}

interface IncomingRingPreset {
  periodMs: number;
  previewMs: number;
  tones: readonly RingTone[];
}

const INCOMING_RINGS: Record<IncomingRingId, IncomingRingPreset> = {
  classic: {
    periodMs: 4000,
    previewMs: 2100,
    tones: [
      { freq: 440, type: "sine", delay: 0, duration: 2, peak: 0.11 },
      { freq: 480, type: "sine", delay: 0, duration: 2, peak: 0.11 },
    ],
  },
  chime: {
    periodMs: 2800,
    previewMs: 900,
    tones: [
      { freq: 523.25, type: "triangle", delay: 0, duration: 0.28, peak: 0.16 },
      { freq: 659.25, type: "triangle", delay: 0.14, duration: 0.32, peak: 0.14 },
    ],
  },
  pulse: {
    periodMs: 2200,
    previewMs: 700,
    tones: [
      { freq: 196, type: "triangle", delay: 0, duration: 0.09, peak: 0.2 },
      { freq: 247, type: "triangle", delay: 0.16, duration: 0.09, peak: 0.18 },
    ],
  },
  marimba: {
    periodMs: 3000,
    previewMs: 900,
    tones: [
      { freq: 392, type: "triangle", delay: 0, duration: 0.14, peak: 0.15 },
      { freq: 494, type: "triangle", delay: 0.11, duration: 0.14, peak: 0.14 },
      { freq: 587, type: "triangle", delay: 0.22, duration: 0.18, peak: 0.13 },
    ],
  },
  glass: {
    periodMs: 2400,
    previewMs: 600,
    tones: [
      { freq: 880, type: "sine", delay: 0, duration: 0.08, peak: 0.1 },
      { freq: 1318.5, type: "sine", delay: 0.14, duration: 0.08, peak: 0.09 },
    ],
  },
};

function stopRunningLoop(cue: "incomingCall" | "outgoingCall"): void {
  const stop = loops.get(cue);
  if (!stop) {
    return;
  }
  loops.delete(cue);
  stop();
}

function trackOscillator(active: OscillatorNode[], osc: OscillatorNode): void {
  active.push(osc);
  osc.onended = () => {
    const index = active.indexOf(osc);
    if (index >= 0) {
      active.splice(index, 1);
    }
  };
}

function scheduleTone(
  ctx: AudioContext,
  dest: GainNode,
  tone: RingTone,
  when: number,
  active: OscillatorNode[],
): void {
  const start = when + tone.delay;
  const attack = Math.min(0.018, tone.duration * 0.25);
  const release = Math.min(0.05, tone.duration * 0.4);
  const peakAt = start + attack;
  const holdEnd = Math.max(peakAt, start + tone.duration - release);
  const end = start + tone.duration;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(tone.peak, peakAt);
  if (holdEnd > peakAt) {
    env.gain.setValueAtTime(tone.peak, holdEnd);
  }
  env.gain.linearRampToValueAtTime(0, end);
  env.connect(dest);
  const osc = ctx.createOscillator();
  osc.type = tone.type;
  osc.frequency.value = tone.freq;
  osc.connect(env);
  osc.start(start);
  osc.stop(end + 0.02);
  trackOscillator(active, osc);
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

  const active: OscillatorNode[] = [];
  const incoming = cue === "incomingCall";
  const preset = incoming ? INCOMING_RINGS[incomingRing] : null;
  const periodMs = preset?.periodMs ?? 5000;

  const burst = () => {
    if (!context || context.state === "closed" || !master) {
      return;
    }
    const when = context.currentTime;
    if (preset) {
      for (const tone of preset.tones) {
        scheduleTone(context, master, tone, when, active);
      }
      return;
    }
    const onSeconds = 1.6;
    const env = context.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(0.12, when + 0.02);
    env.gain.setValueAtTime(0.12, when + onSeconds - 0.04);
    env.gain.linearRampToValueAtTime(0, when + onSeconds);
    env.connect(master);
    for (const freq of [425, 450]) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(env);
      osc.start(when);
      osc.stop(when + onSeconds + 0.02);
      trackOscillator(active, osc);
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

const loopTokens: Record<"incomingCall" | "outgoingCall", number> = {
  incomingCall: 0,
  outgoingCall: 0,
};

export function playCue(cue: SoundCue): void {
  if (!isCueEnabled(state, cue)) {
    return;
  }
  unlockSounds();
  if (cue === "incomingCall" || cue === "outgoingCall") {
    // Preview: one burst, not a loop. Token so a real call started during
    // the preview is not killed when this timeout fires.
    const token = ++loopTokens[cue];
    startToneLoop(cue);
    const delay =
      cue === "incomingCall" ? INCOMING_RINGS[incomingRing].previewMs : 1700;
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        if (token === loopTokens[cue]) {
          stopSoundLoop(cue);
        }
      }, delay);
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
  incomingRing = DEFAULT_INCOMING_RING;
  state = { ...DEFAULT_STATE };
  listeners.clear();
}

/** Visible to tests: whether a loop is currently scheduled. */
export function soundLoopIsRunningForTests(
  cue: "incomingCall" | "outgoingCall",
): boolean {
  return loops.has(cue);
}

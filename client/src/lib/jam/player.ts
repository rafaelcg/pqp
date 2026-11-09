import {
  type LoopRegion,
  type StemMix,
  type StemTiming,
  type TransportAnchor,
  clampSeek,
  effectiveGains,
  planSegment,
  positionAt,
  segmentAt,
  songDurationMs,
} from "./timeline";
import { attachVideo as attachVideoElement } from "./video-sync";

/**
 * Synced playback of N stems on one AudioContext.
 *
 * Every stem is an AudioBuffer behind its own GainNode, all into one master
 * gain. Playing schedules one AudioBufferSourceNode per stem per pass, every
 * one of them computed by `planSegment` against the same start frame, so the
 * stems are sample-aligned by construction rather than by luck: there is no
 * "start them all at roughly the same moment".
 *
 * Two clocks, kept apart on purpose:
 *   - GRAPH time: what is leaving the graph now (`context.currentTime`).
 *     Scheduling and recording use it.
 *   - HEARD time: what is coming out of the speaker now, `getOutputTimestamp`
 *     when the browser gives a sane one, otherwise graph time minus
 *     `baseLatency + outputLatency`. The playhead and the video follow it,
 *     because a playhead that runs ahead of the sound looks wrong.
 */

export interface JamStemInit {
  id: string;
  buffer: AudioBuffer;
  offsetMs?: number;
  trimStartMs?: number;
  trimEndMs?: number;
  gain?: number;
  muted?: boolean;
  solo?: boolean;
}

export type JamStemPatch = Partial<Pick<JamStemInit, "offsetMs" | "trimStartMs" | "trimEndMs" | "gain" | "muted" | "solo">>;

export interface JamStemState extends StemTiming, StemMix {
  id: string;
}

export type TransportState = "stopped" | "playing" | "paused";

export interface JamClockTick {
  state: TransportState;
  /** Song time being heard, ms. */
  positionMs: number;
  durationMs: number;
  loop: LoopRegion | null;
}

interface StemSlot {
  id: string;
  buffer: AudioBuffer;
  timing: StemTiming;
  mix: StemMix;
  gainNode: GainNode;
}

/** How far ahead of `currentTime` a fresh start is scheduled, seconds. */
const START_LEAD_SEC = 0.06;
/** How far ahead loop passes are scheduled. More than a background tab's 1 s timer clamp. */
const LOOP_LOOKAHEAD_SEC = 1.6;

export class JamPlayer {
  readonly context: AudioContext;
  readonly master: GainNode;
  private readonly slots = new Map<string, StemSlot>();
  private sources: { node: AudioBufferSourceNode; endsAt: number }[] = [];
  private anchor: TransportAnchor | null = null;
  private anchorFrame = 0;
  private passesScheduled = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private listeners = new Set<(tick: JamClockTick) => void>();
  private loop: LoopRegion | null = null;
  private stateValue: TransportState = "stopped";
  private parkedMs = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(context?: AudioContext) {
    this.context = context ?? new AudioContext({ latencyHint: "interactive" });
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get state(): TransportState {
    return this.stateValue;
  }

  // -- stems ---------------------------------------------------------------

  /** Decode encoded audio (FLAC, WAV, anything the browser reads) on this context. */
  async decode(data: ArrayBuffer | Blob | string): Promise<AudioBuffer> {
    let bytes: ArrayBuffer;
    if (typeof data === "string") {
      const res = await fetch(data);
      if (!res.ok) throw new Error(`jam: fetch ${res.status}`);
      bytes = await res.arrayBuffer();
    } else if (data instanceof Blob) {
      bytes = await data.arrayBuffer();
    } else {
      // decodeAudioData detaches its argument; keep the caller's copy usable
      bytes = data.slice(0);
    }
    return this.context.decodeAudioData(bytes);
  }

  addStem(init: JamStemInit): void {
    this.removeStem(init.id);
    const gainNode = this.context.createGain();
    gainNode.connect(this.master);
    this.slots.set(init.id, {
      id: init.id,
      buffer: init.buffer,
      timing: {
        offsetMs: init.offsetMs ?? 0,
        trimStartMs: init.trimStartMs ?? 0,
        trimEndMs: init.trimEndMs ?? 0,
        durationMs: (init.buffer.length / init.buffer.sampleRate) * 1000,
      },
      mix: { gain: init.gain ?? 1, muted: init.muted ?? false, solo: init.solo ?? false },
      gainNode,
    });
    this.applyGains(true);
    this.restartIfPlaying();
  }

  /** Fetch or take bytes, decode, and add. */
  async loadStem(
    id: string,
    data: ArrayBuffer | Blob | string,
    placement: Omit<JamStemInit, "id" | "buffer"> = {},
  ): Promise<JamStemState> {
    const buffer = await this.decode(data);
    this.addStem({ id, buffer, ...placement });
    return this.stem(id)!;
  }

  /**
   * Change a stem's numbers. Gain, mute and solo ramp in place (10 ms, no
   * click); offset and trims re-schedule from the current position, which
   * costs a 60 ms re-start while playing and nothing while paused.
   */
  updateStem(id: string, patch: JamStemPatch): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const timingChanged =
      (patch.offsetMs !== undefined && patch.offsetMs !== slot.timing.offsetMs) ||
      (patch.trimStartMs !== undefined && patch.trimStartMs !== slot.timing.trimStartMs) ||
      (patch.trimEndMs !== undefined && patch.trimEndMs !== slot.timing.trimEndMs);
    slot.timing = {
      ...slot.timing,
      offsetMs: patch.offsetMs ?? slot.timing.offsetMs,
      trimStartMs: Math.max(0, patch.trimStartMs ?? slot.timing.trimStartMs),
      trimEndMs: Math.max(0, patch.trimEndMs ?? slot.timing.trimEndMs),
    };
    slot.mix = {
      gain: patch.gain ?? slot.mix.gain,
      muted: patch.muted ?? slot.mix.muted,
      solo: patch.solo ?? slot.mix.solo,
    };
    this.applyGains(false);
    if (timingChanged) this.restartIfPlaying();
    this.emit();
  }

  removeStem(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.gainNode.disconnect();
    this.slots.delete(id);
    this.applyGains(false);
    this.restartIfPlaying();
  }

  stem(id: string): JamStemState | null {
    const s = this.slots.get(id);
    return s ? { id, ...s.timing, ...s.mix } : null;
  }

  stems(): JamStemState[] {
    return [...this.slots.keys()].map((id) => this.stem(id)!);
  }

  /** The decoded buffer of a stem, for a mixdown or a waveform. */
  buffer(id: string): AudioBuffer | null {
    return this.slots.get(id)?.buffer ?? null;
  }

  get durationMs(): number {
    return songDurationMs([...this.slots.values()].map((s) => s.timing));
  }

  setMasterGain(gain: number): void {
    this.master.gain.setTargetAtTime(Math.max(0, gain), this.context.currentTime, 0.01);
  }

  private applyGains(immediate: boolean) {
    const gains = effectiveGains([...this.slots.values()].map((s) => ({ id: s.id, mix: s.mix })));
    for (const slot of this.slots.values()) {
      const g = gains.get(slot.id) ?? 0;
      if (immediate) slot.gainNode.gain.value = g;
      else slot.gainNode.gain.setTargetAtTime(g, this.context.currentTime, 0.01);
    }
  }

  // -- transport -----------------------------------------------------------

  /** Loop a region (>= 10 ms), or null to stop looping. Applies from the next start. */
  setLoop(loop: LoopRegion | null): void {
    this.loop = loop && loop.endMs - loop.startMs >= 10 ? { ...loop } : null;
    if (this.stateValue === "playing" && this.anchor) {
      const at = this.context.currentTime + START_LEAD_SEC;
      this.startAt(positionAt(this.anchor, at), at, this.loop);
    }
    this.emit();
  }

  getLoop(): LoopRegion | null {
    return this.loop;
  }

  /** Start (or restart) from `fromMs`, or from where it was paused. */
  async play(fromMs?: number): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
    let from = fromMs ?? this.parkedMs;
    if (fromMs === undefined && from >= this.durationMs - 1) from = 0;
    this.startAt(from, this.context.currentTime + START_LEAD_SEC, this.loop);
  }

  /**
   * Schedule playback so that song time `fromMs` leaves the graph exactly at
   * context time `ctxStart`. The recorder uses this to put the backing a
   * count-in after the capture starts; `loop: null` forces a straight run.
   * Returns the context frame at which `fromMs` leaves the graph.
   */
  startAt(fromMs: number, ctxStart: number, loop: LoopRegion | null = this.loop): number {
    this.cancelSources();
    const from = clampSeek(fromMs, this.durationMs);
    const frame = Math.round(ctxStart * this.sampleRate);
    this.anchorFrame = frame;
    this.anchor = { songStartMs: from, ctxStart: frame / this.sampleRate, loop };
    this.passesScheduled = 0;
    this.stateValue = "playing";
    this.schedulePasses();
    if (loop) {
      this.timer = setInterval(() => this.schedulePasses(), 100);
    } else {
      this.armEnd();
    }
    this.startTicking();
    this.emit();
    return frame;
  }

  pause(): void {
    if (this.stateValue !== "playing") return;
    this.parkedMs = this.positionMs();
    this.cancelSources();
    this.stateValue = "paused";
    this.emit();
  }

  stop(): void {
    this.cancelSources();
    this.parkedMs = 0;
    this.stateValue = "stopped";
    this.emit();
  }

  seek(ms: number): void {
    const to = clampSeek(ms, this.durationMs);
    if (this.stateValue === "playing") {
      this.startAt(to, this.context.currentTime + START_LEAD_SEC, this.loop);
    } else {
      this.parkedMs = to;
      this.emit();
    }
  }

  /**
   * Re-schedule from where playback is, keeping the run's own loop setting
   * (a take's straight run stays straight if a stem is edited mid-take).
   */
  private restartIfPlaying() {
    if (this.stateValue === "playing" && this.anchor) {
      const at = this.context.currentTime + START_LEAD_SEC;
      this.startAt(positionAt(this.anchor, at), at, this.anchor.loop);
    }
  }

  private schedulePasses() {
    const anchor = this.anchor;
    if (!anchor) return;
    const sr = this.sampleRate;
    const end = this.durationMs;
    const horizon = this.context.currentTime + LOOP_LOOKAHEAD_SEC;
    for (;;) {
      const seg = segmentAt(anchor, this.passesScheduled, end, sr);
      if (!seg) break;
      const segFrame = this.anchorFrame + seg.startFrames;
      if (this.passesScheduled > 0 && segFrame / sr > horizon) break;
      this.scheduleSegment(seg.fromMs, seg.toMs, segFrame);
      this.passesScheduled++;
    }
    const now = this.context.currentTime;
    this.sources = this.sources.filter((s) => s.endsAt > now);
  }

  private scheduleSegment(fromMs: number, toMs: number, segFrame: number) {
    const sr = this.sampleRate;
    const list = [...this.slots.values()];
    const plan = planSegment(
      list.map((s) => ({ id: s.id, timing: s.timing })),
      fromMs,
      toMs,
      sr,
    );
    for (const entry of plan) {
      const slot = this.slots.get(entry.id);
      if (!slot) continue;
      const node = this.context.createBufferSource();
      node.buffer = slot.buffer;
      node.connect(slot.gainNode);
      const when = (segFrame + entry.startFrame) / sr;
      // A start in the past would be played "now", shifted; clip its head instead.
      const late = Math.max(0, Math.ceil((this.context.currentTime - when) * sr));
      const offsetFrames = entry.bufferOffsetFrames + late;
      const durFrames = entry.durationFrames - late;
      if (durFrames <= 0) continue;
      node.start((segFrame + entry.startFrame + late) / sr, offsetFrames / sr, durFrames / sr);
      this.sources.push({ node, endsAt: (segFrame + entry.startFrame + entry.durationFrames) / sr });
    }
  }

  private armEnd() {
    if (!this.anchor) return;
    const remainingMs = this.durationMs - this.anchor.songStartMs;
    const endsAt = this.anchor.ctxStart + remainingMs / 1000 + this.outputLatencySec();
    const wait = Math.max(0, (endsAt - this.context.currentTime) * 1000) + 30;
    this.endTimer = setTimeout(() => {
      if (this.stateValue === "playing" && !this.anchor?.loop) {
        this.cancelSources();
        this.parkedMs = this.durationMs;
        this.stateValue = "stopped";
        this.emit();
      }
    }, wait);
  }

  private cancelSources() {
    for (const s of this.sources) {
      try {
        s.node.stop();
      } catch {
        /* never started */
      }
      s.node.disconnect();
    }
    this.sources = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.anchor = null;
  }

  // -- clocks --------------------------------------------------------------

  /** `baseLatency + outputLatency`, seconds, 0 where not reported. */
  outputLatencySec(): number {
    const c = this.context as AudioContext & { outputLatency?: number; baseLatency?: number };
    const base = typeof c.baseLatency === "number" && Number.isFinite(c.baseLatency) ? c.baseLatency : 0;
    const out = typeof c.outputLatency === "number" && Number.isFinite(c.outputLatency) ? c.outputLatency : 0;
    return base + out;
  }

  /** Context time of the sample coming out of the speaker now. */
  heardContextTime(): number {
    const now = this.context.currentTime;
    try {
      const ts = this.context.getOutputTimestamp?.();
      if (ts && typeof ts.contextTime === "number" && typeof ts.performanceTime === "number" && ts.performanceTime > 0) {
        const t = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        // trust it only when it is behind the graph by a believable amount
        if (t <= now + 0.005 && t >= now - 0.5) return t;
      }
    } catch {
      /* fall through */
    }
    return now - this.outputLatencySec();
  }

  /** Song time being heard now, ms. */
  positionMs(): number {
    if (this.stateValue !== "playing" || !this.anchor) return this.parkedMs;
    const p = positionAt(this.anchor, this.heardContextTime());
    return Math.min(Math.max(p, this.anchor.songStartMs), Math.max(this.durationMs, this.anchor.songStartMs));
  }

  /** Song time leaving the graph now, ms (what a recorder lines up against). */
  graphPositionMs(): number {
    if (this.stateValue !== "playing" || !this.anchor) return this.parkedMs;
    return positionAt(this.anchor, this.context.currentTime);
  }

  /** Context frame at which the current run's start position left the graph. */
  runStartFrame(): number | null {
    return this.anchor ? this.anchorFrame : null;
  }

  /** Called every animation frame while playing, and on every state change. */
  subscribe(listener: (tick: JamClockTick) => void): () => void {
    this.listeners.add(listener);
    listener(this.tick());
    return () => this.listeners.delete(listener);
  }

  private tick(): JamClockTick {
    return { state: this.stateValue, positionMs: this.positionMs(), durationMs: this.durationMs, loop: this.loop };
  }

  private emit() {
    const t = this.tick();
    for (const l of this.listeners) l(t);
  }

  private startTicking() {
    if (this.raf || typeof requestAnimationFrame !== "function") return;
    const loop = () => {
      if (this.stateValue !== "playing") {
        this.raf = 0;
        return;
      }
      this.emit();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // -- video ---------------------------------------------------------------

  /**
   * Keep a muted <video> on this stem: video time = the stem's buffer time
   * being heard. A take recorded with a camera is cut so its buffer starts
   * at the video's first frame, so the same `offsetMs` places both. Returns
   * the detach function.
   */
  attachVideo(stemId: string, video: HTMLVideoElement): () => void {
    return attachVideoElement(video, {
      heardBufferSec: () => {
        const slot = this.slots.get(stemId);
        if (!slot) return null;
        return (this.positionMs() - slot.timing.offsetMs) / 1000;
      },
      isPlaying: () => this.stateValue === "playing",
    });
  }

  async destroy(): Promise<void> {
    this.cancelSources();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.listeners.clear();
    for (const s of this.slots.values()) s.gainNode.disconnect();
    this.slots.clear();
    if (this.context.state !== "closed") await this.context.close();
  }
}

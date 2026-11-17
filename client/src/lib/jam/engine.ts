import { type LoopbackOptions, type TapAlongOptions, calibrateLoopback, calibrateTapAlong } from "./calibrate";
import { JamInput, currentDevicePair } from "./input";
import {
  type DevicePair,
  type LatencyEstimate,
  type LatencyResult,
  LatencyStore,
  type OutputAssessment,
  assessOutput,
  chooseLatency,
  devicePairKey,
  estimateFromReported,
  isStale,
} from "./latency";
import { type MixdownStem, exportMixdown } from "./mixdown";
import { JamPlayer } from "./player";
import { type JamTake, type RecordOptions, type RecordingHandle, startRecording, takeToBuffer } from "./recorder";

/**
 * The one object a screen needs: a player, an instrument input, the latency
 * that applies to the current pair of devices, and recording.
 *
 *   const engine = await JamEngine.create();
 *   await engine.player.loadStem("guitar", url, { offsetMs: 0 });
 *   await engine.openInput();                 // after a click: asks for the mic
 *   const lat = await engine.latency();       // what will be compensated, and how sure
 *   if (lat.current.method === "estimate") await engine.calibrate("loopback");
 *   const rec = await engine.record({ countIn: { bars: 1, beatsPerBar: 4, bpm: 120 } });
 *   const take = await rec.stop();            // already placed: take.offsetMs
 *   engine.addTake("bass", take);             // hear it in the mix right away
 *   const upload = await prepareStemUpload(take);
 */

export interface LatencyStatus {
  /** What a recording made now would compensate with. */
  current: LatencyResult;
  estimate: LatencyEstimate;
  /** Measurements stored for this device pair (stale ones included, flagged). */
  stored: (LatencyResult & { stale: boolean })[];
  devices: DevicePair;
  key: string;
  output: OutputAssessment;
}

export class JamEngine {
  readonly player: JamPlayer;
  input: JamInput | null = null;
  private readonly store: LatencyStore;
  private deviceListeners = new Set<(status: LatencyStatus) => void>();
  private lastKey: string | null = null;
  private readonly onDeviceChange = () => void this.checkDevices().catch(() => undefined);

  private constructor(player: JamPlayer, store: LatencyStore) {
    this.player = player;
    this.store = store;
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
  }

  static async create(options: { context?: AudioContext; store?: LatencyStore } = {}): Promise<JamEngine> {
    return new JamEngine(new JamPlayer(options.context), options.store ?? new LatencyStore());
  }

  get context(): AudioContext {
    return this.player.context;
  }

  private opening: Promise<unknown> = Promise.resolve();
  private destroyed = false;

  /**
   * Open (or switch) the instrument input. Needs a user gesture on Safari.
   * Opens are serialised, and the previous input stays live until the new
   * one has opened: a refused permission or an unplugged device leaves the
   * engine on the input it had, never on a closed one.
   */
  openInput(options: { deviceId?: string } = {}): Promise<JamInput> {
    const run = this.opening.then(async () => {
      if (this.context.state !== "running") await this.context.resume();
      const next = await JamInput.open(this.context, options);
      if (this.destroyed) {
        next.close();
        throw new Error("jam: engine destroyed while the input was opening");
      }
      const previous = this.input;
      this.input = next;
      previous?.close();
      next.track.addEventListener("ended", this.onDeviceChange);
      // the input is open whatever happens next; a failed device listing
      // only means the change detector starts without a baseline
      try {
        this.lastKey = (await this.latency()).key;
      } catch {
        this.lastKey = null;
      }
      // destroy() may have run during that await and closed `next`
      if (this.destroyed) throw new Error("jam: engine destroyed while the input was opening");
      return next;
    });
    this.opening = run.catch(() => undefined);
    return run;
  }

  /**
   * `baseLatency + outputLatency` in ms, or null while `outputLatency` is not
   * known. Chrome reports 0 for a moment after the context starts and the
   * real value a few hundred ms later (seen in headless Chromium: 0, then
   * 24 ms); judging staleness against that 0 would throw away a good
   * calibration on every page load.
   */
  private reportedOutputMs(): number | null {
    const c = this.context as AudioContext & { outputLatency?: number; baseLatency?: number };
    if (!(typeof c.outputLatency === "number" && c.outputLatency > 0)) return null;
    return (c.outputLatency + (typeof c.baseLatency === "number" ? c.baseLatency : 0)) * 1000;
  }

  async latency(): Promise<LatencyStatus> {
    const devices = await currentDevicePair(this.context, this.input);
    const key = devicePairKey(devices);
    const c = this.context as AudioContext & { outputLatency?: number; baseLatency?: number };
    const estimate = estimateFromReported({
      baseLatency: c.baseLatency,
      outputLatency: c.outputLatency,
      ...(this.input?.reportedInput() ?? {}),
    });
    const now = this.reportedOutputMs();
    const stored = this.store.get(key);
    return {
      current: chooseLatency(stored, estimate, now),
      estimate,
      stored: stored.map((r) => ({ ...r, stale: isStale(r, now) })),
      devices,
      key,
      output: assessOutput(devices.output.label, c.outputLatency),
    };
  }

  /** Measure and store for the current device pair. */
  async calibrate(method: "loopback", options?: LoopbackOptions): Promise<LatencyResult>;
  async calibrate(method: "tap-along", options?: TapAlongOptions): Promise<LatencyResult>;
  async calibrate(method: "loopback" | "tap-along", options: LoopbackOptions | TapAlongOptions = {}): Promise<LatencyResult> {
    const input = this.input;
    if (!input) throw new Error("jam: open an input first");
    this.player.pause();
    // the pair being measured, fixed now: a device switched mid-calibration
    // must not have this result filed under it
    const keyBefore = (await this.latency()).key;
    const result =
      method === "loopback"
        ? await calibrateLoopback(input, options as LoopbackOptions)
        : await calibrateTapAlong(input, options as TapAlongOptions);
    result.reportedOutputMs = this.reportedOutputMs();
    const keyAfter = (await this.latency()).key;
    if (keyAfter !== keyBefore || this.input !== input) {
      result.note = "The devices changed during the calibration, so the result was not kept. Run it again.";
      return result;
    }
    // Only a result worth recording over is remembered; a low one is shown
    // (with its note) so the person can retry, and the previous value stays.
    if (result.confidence === "high" || result.confidence === "medium") {
      this.store.save(keyBefore, result);
    }
    return result;
  }

  /** A typed-in round trip (the nudge for the whole device pair). Beats any measurement. */
  async setManualLatency(roundTripMs: number | null): Promise<void> {
    const { key } = await this.latency();
    if (roundTripMs === null) {
      const kept = this.store.get(key).filter((r) => r.method !== "manual");
      this.store.clear(key);
      for (const r of kept) this.store.save(key, r);
      return;
    }
    this.store.save(key, {
      method: "manual",
      roundTripMs,
      confidence: "medium",
      spreadMs: 0,
      accepted: 0,
      played: 0,
      at: Date.now(),
    });
  }

  async record(options: Omit<RecordOptions, "latency"> & { latency?: LatencyResult }): Promise<RecordingHandle> {
    if (!this.input) throw new Error("jam: open an input first");
    const latency = options.latency ?? (await this.latency()).current;
    return startRecording(this.player, this.input, { ...options, latency });
  }

  /** Put a finished take into the mix at its measured place. */
  addTake(id: string, take: JamTake, gain = 1): void {
    this.player.addStem({
      id,
      buffer: takeToBuffer(this.context, take),
      offsetMs: take.offsetMs,
      trimStartMs: take.trimStartMs,
      trimEndMs: take.trimEndMs,
      gain,
    });
  }

  /** The current mix as a file (FLAC by default). */
  async exportMix(format: "flac" | "wav" = "flac"): Promise<Blob> {
    const stems: MixdownStem[] = this.player.stems().map((s) => ({
      id: s.id,
      buffer: this.player.buffer(s.id)!,
      timing: s,
      mix: s,
    }));
    return exportMixdown(stems, format, { sampleRate: this.context.sampleRate });
  }

  /**
   * Called when the input or output device changes under us (a plug, an
   * unplug, the OS switching the default). The stored calibration for the
   * new pair, if any, is what `latency().current` now returns.
   */
  onDevicesChanged(listener: (status: LatencyStatus) => void): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
  }

  private async checkDevices() {
    const status = await this.latency();
    if (status.key !== this.lastKey || this.input?.track.readyState === "ended") {
      this.lastKey = status.key;
      for (const l of this.deviceListeners) l(status);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.input?.close();
    this.input = null;
    await this.player.destroy();
  }
}

import captureWorkletUrl from "./capture-worklet.js?url&no-inline";
import { type Assembled, type StampedChunk, assembleChunks } from "./assemble";
import type { DevicePair, ReportedLatencies } from "./latency";

/**
 * The instrument input: a raw microphone (or interface) track, wired into the
 * capture worklet on the player's own AudioContext.
 *
 * NOT the call's microphone chain. `createMicPipeline` (docs/NOISE_SUPPRESSION.md)
 * runs RNNoise and a voice gate and leaves the browser's processing on; all
 * of that is made for speech and wrecks an instrument (a gate chops a
 * sustained note's tail, AGC pumps, echo cancellation cancels the backing
 * the player is playing along to and with it half the guitar). This opens
 * its own track with every one of those switched off.
 */

/** Constraints for an instrument: no speech processing of any kind. */
export function instrumentConstraints(deviceId?: string): MediaTrackConstraints {
  const c: MediaTrackConstraints & Record<string, unknown> = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // Chrome's legacy names for the same switches, still honoured by some
    // builds and by Electron's older Chromium.
    googEchoCancellation: false,
    googNoiseSuppression: false,
    googAutoGainControl: false,
    googHighpassFilter: false,
    // Two-input interfaces: ask for both sides and pick later (`chooseMono`).
    channelCount: { ideal: 2 },
  };
  if (deviceId) c.deviceId = { exact: deviceId };
  // Chrome 116+ lets a page ask for voice isolation off explicitly.
  (c as Record<string, unknown>).voiceIsolation = false;
  return c;
}

/** Must match `CAPTURE_PROCESSOR` in `capture-worklet.js` (pinned by a test). */
export const CAPTURE_PROCESSOR_NAME = "pqp-jam-capture";

/** `addModule` is per context and not worth paying for twice. */
const modulesAdded = new WeakSet<BaseAudioContext>();

export async function ensureCaptureModule(context: BaseAudioContext): Promise<void> {
  if (modulesAdded.has(context)) return;
  await context.audioWorklet.addModule(captureWorkletUrl);
  modulesAdded.add(context);
}

/** `MediaStreamTrack.stats` (Chrome 125+). Every field is in milliseconds. */
interface TrackStats {
  latency?: number;
  deliveredFramesDuration?: number;
  totalFramesDuration?: number;
}

export class JamInput {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  readonly context: AudioContext;
  readonly channelCount: number;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode;
  private readonly sink: GainNode;
  private readonly monitorGain: GainNode;
  private chunks: StampedChunk[] = [];
  private stopWaiter: ((frame: number) => void) | null = null;
  private capturing = false;

  private constructor(context: AudioContext, stream: MediaStream) {
    this.context = context;
    this.stream = stream;
    this.track = stream.getAudioTracks()[0];
    const settings = this.track.getSettings();
    this.channelCount = Math.max(1, Math.min(2, settings.channelCount ?? 1));
    this.source = context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: this.channelCount,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    // A node nobody pulls may not be processed (Chrome, WebKit); a silent
    // route to the destination keeps it running everywhere.
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(context.destination);
    this.monitorGain = context.createGain();
    this.monitorGain.gain.value = 0;
    this.source.connect(this.monitorGain);
    this.monitorGain.connect(context.destination);
    this.node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; frame: number; channels?: Float32Array[] };
      if (data.type === "chunk" && data.channels) {
        this.chunks.push({ frame: data.frame, channels: data.channels });
      } else if (data.type === "stopped") {
        this.stopWaiter?.(data.frame);
        this.stopWaiter = null;
      }
    };
  }

  /**
   * Ask for the instrument and wire it in. Needs a user gesture somewhere
   * before it on Safari, like any getUserMedia.
   */
  static async open(context: AudioContext, options: { deviceId?: string } = {}): Promise<JamInput> {
    await ensureCaptureModule(context);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: instrumentConstraints(options.deviceId),
      video: false,
    });
    try {
      return new JamInput(context, stream);
    } catch (err) {
      // never leave a microphone running behind a failed open
      for (const t of stream.getTracks()) t.stop();
      throw err;
    }
  }

  get deviceId(): string {
    return this.track.getSettings().deviceId ?? "";
  }

  get label(): string {
    return this.track.label;
  }

  /** What the browser did with our constraints (to show, and to catch a browser that ignored them). */
  settings(): MediaTrackSettings {
    return this.track.getSettings();
  }

  /**
   * Begin capturing with the render quantum that holds `atFrame`. Every
   * chunk from here on is stamped with its context frame.
   */
  startCapture(atFrame: number): void {
    this.chunks = [];
    this.capturing = true;
    this.node.port.postMessage({ type: "start", atFrame, channels: this.channelCount });
  }

  /**
   * Stop and hand back everything captured, laid out by frame. `truncated`
   * is true when the worklet never acknowledged the stop (a suspended or
   * closed context): the take is what arrived, and its last fraction of a
   * second may be missing.
   */
  async stopCapture(): Promise<(Assembled & { truncated: boolean }) | null> {
    if (!this.capturing) return null;
    this.capturing = false;
    const ack = await new Promise<number>((resolve) => {
      this.stopWaiter = resolve;
      this.node.port.postMessage({ type: "stop" });
      // a closed or suspended context would never answer
      setTimeout(() => resolve(-1), 2000);
    });
    this.stopWaiter = null;
    // hand the chunk list over and let the assembler release each chunk as
    // it copies it, so a long take is not held twice at the peak
    const chunks = this.chunks;
    this.chunks = [];
    const out = assembleChunks(chunks, { release: true });
    return out ? { ...out, truncated: ack < 0 } : null;
  }

  /**
   * Hear yourself through the browser. Off by default and best left off: it
   * comes back a full round trip late (tens of ms), which is what an
   * interface's own direct monitoring exists to avoid.
   */
  setMonitor(on: boolean, gain = 1): void {
    this.monitorGain.gain.setTargetAtTime(on ? gain : 0, this.context.currentTime, 0.01);
  }

  /** What the browser reports about this track's latency (for the estimate). */
  reportedInput(): Pick<ReportedLatencies, "trackStatsLatencyMs" | "settingsLatency"> {
    const settings = this.track.getSettings() as MediaTrackSettings & { latency?: number };
    const stats = (this.track as MediaStreamTrack & { stats?: TrackStats }).stats;
    return {
      trackStatsLatencyMs: typeof stats?.latency === "number" ? stats.latency : undefined,
      settingsLatency: typeof settings.latency === "number" ? settings.latency : undefined,
    };
  }

  /**
   * Audio the browser dropped on the way in, ms, from Chrome's
   * `MediaStreamTrack.stats` (125+). Null where not available. A take whose
   * count grew while recording has a click or a gap in it.
   */
  droppedInputMs(): number | null {
    const stats = (this.track as MediaStreamTrack & { stats?: TrackStats }).stats;
    if (!stats || typeof stats.totalFramesDuration !== "number" || typeof stats.deliveredFramesDuration !== "number") {
      return null;
    }
    return Math.max(0, stats.totalFramesDuration - stats.deliveredFramesDuration);
  }

  close(): void {
    try {
      this.source.disconnect();
      this.node.disconnect();
      this.sink.disconnect();
      this.monitorGain.disconnect();
    } catch {
      /* already gone */
    }
    for (const t of this.stream.getTracks()) t.stop();
  }
}

/** `getUserMedia` instrument inputs, for a picker. Labels need a granted permission first. */
export async function listInputs(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput");
}

/**
 * The input and output this context is actually using, for the calibration
 * key and the Bluetooth check. The output is the context's `sinkId` (Chrome
 * 110+) or the default device, whose label in Chrome names the real device.
 */
export async function currentDevicePair(context: AudioContext, input: JamInput | null): Promise<DevicePair> {
  let outputs: MediaDeviceInfo[] = [];
  try {
    outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  } catch {
    outputs = [];
  }
  const sinkId = (context as AudioContext & { sinkId?: string | { type: string } }).sinkId;
  const outId = typeof sinkId === "string" && sinkId ? sinkId : "default";
  const out = outputs.find((d) => d.deviceId === outId) ?? outputs.find((d) => d.deviceId === "default") ?? outputs[0];
  const settings = input?.settings();
  return {
    input: {
      deviceId: settings?.deviceId ?? "",
      label: input?.label ?? "",
      groupId: settings?.groupId,
    },
    output: { deviceId: outId, label: out?.label ?? "" },
    sampleRate: context.sampleRate,
  };
}

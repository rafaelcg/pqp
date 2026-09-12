/**
 * The host's voice in the stream.
 *
 * THE PROBLEM. The HLS transcode is bound to two tracks, the screen share and
 * that share's own audio, so a host talking over a film was heard by the
 * seated room and by nobody watching from outside. `docs/plans/
 * WATCH_PARTY_STREAM_AUDIO.md` weighs the ways out; this is the one it
 * recommends: the browser mixes the microphone INTO the screen-share audio
 * track before publishing, and the egress never learns anything changed.
 * Zero cost on the media box, client-only, rolls back with a Pages deploy.
 *
 * WHAT IS MIXED. The display capture's audio, if it had any, plus the
 * microphone's PROCESSED stream (the pipeline's output, after gain and the
 * mute gate), so the host's mute button mutes the stream too, and a capture
 * with no audio of its own becomes the mic alone, which beats the silence it
 * produced before.
 *
 * LEVELS (2026-09-12). Summed at unity, a film sitting near full scale drowned
 * a processed mic: the first live test came back "mic works. might need audio
 * settings cause mic was low compared to video being streamed." Each branch
 * now has its own `GainNode` (`displayGain` default 0.7 / -3 dB, `micGain`
 * default 2.0 / +6 dB — see `stream-mix-levels.ts` for the ranges and the
 * per-browser storage), and both feed a `DynamicsCompressorNode` so the
 * boosted mic cannot clip the bus. On top of that, an `AnalyserNode` on the
 * mic branch ducks the display branch by another -6 dB while the host is
 * actually talking (RMS above -40 dBFS), and lets it back up 600ms after they
 * stop — a talking host should be heard over the film, not fighting it.
 *
 * The AudioContext is injectable so the mix is testable in Node.
 */

import {
  DISPLAY_GAIN_RANGE,
  MIC_GAIN_RANGE,
  readStreamMixLevels,
} from "./stream-mix-levels";

export interface AudioParamLike {
  value: number;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): void;
}

export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface CompressorNodeLike extends AudioNodeLike {
  threshold: AudioParamLike;
  knee: AudioParamLike;
  ratio: AudioParamLike;
  attack: AudioParamLike;
  release: AudioParamLike;
}

export interface AnalyserNodeLike extends AudioNodeLike {
  fftSize: number;
  getFloatTimeDomainData(array: Float32Array): void;
}

export interface AudioContextLike {
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createMediaStreamDestination(): { stream: MediaStream } & AudioNodeLike;
  createGain(): GainNodeLike;
  createDynamicsCompressor(): CompressorNodeLike;
  /** Optional: a context that cannot build one just does not get ducking. */
  createAnalyser?(): AnalyserNodeLike;
  readonly currentTime: number;
  close(): Promise<void> | void;
}

export interface AudioNodeLike {
  connect(target: AudioNodeLike): unknown;
  disconnect(): void;
}

/** RMS above this is "the host is talking", the ducking trigger. -40 dBFS. */
const DUCK_THRESHOLD_DBFS = -40;
/** How much further the display branch drops while the mic is loud. */
const DUCK_FACTOR = 0.5;
/** Attack / release time constants for `setTargetAtTime`, in seconds. */
const DUCK_ATTACK_SECONDS = 0.05;
const DUCK_RELEASE_SECONDS = 0.4;
/** How long the mic must be quiet before the display branch comes back up. */
const DUCK_RELEASE_HOLD_MS = 600;
const DUCK_POLL_MS = 50;

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

export interface ScreenMix {
  /** The display's video track plus one mixed audio track. Publish this. */
  stream: MediaStream;
  /** Swap the microphone branch (device change), or drop it with null. */
  setMic(stream: MediaStream | null): void;
  /** True while a microphone is in the mix. */
  micIn(): boolean;
  /** The mic branch's gain, live on the running mix. Clamped 0.5 - 4. */
  setMicGain(value: number): void;
  /** The display branch's gain, live on the running mix. Clamped 0.25 - 1. */
  setDisplayGain(value: number): void;
  close(): void;
}

export function createScreenMix(
  display: MediaStream,
  mic: MediaStream | null,
  makeContext: () => AudioContextLike = () => new AudioContext(),
): ScreenMix {
  const context = makeContext();
  const destination = context.createMediaStreamDestination();

  const initialLevels = readStreamMixLevels();

  // The bus: both branches feed a limiter so the boosted mic cannot clip.
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -6;
  compressor.knee.value = 6;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  compressor.connect(destination);

  const displayGainNode = context.createGain();
  let baseDisplayGain = clamp(initialLevels.displayGain, DISPLAY_GAIN_RANGE);
  displayGainNode.gain.value = baseDisplayGain;
  displayGainNode.connect(compressor);

  const micGainNode = context.createGain();
  micGainNode.gain.value = clamp(initialLevels.micGain, MIC_GAIN_RANGE);
  micGainNode.connect(compressor);

  const displayAudio = display.getAudioTracks();
  let displaySource: AudioNodeLike | null = null;
  if (displayAudio.length > 0) {
    displaySource = context.createMediaStreamSource(
      new MediaStream(displayAudio),
    );
    displaySource.connect(displayGainNode);
  }

  let micSource: AudioNodeLike | null = null;
  const setMic = (stream: MediaStream | null) => {
    micSource?.disconnect();
    micSource = null;
    if (stream && stream.getAudioTracks().length > 0) {
      micSource = context.createMediaStreamSource(
        new MediaStream(stream.getAudioTracks()),
      );
      micSource.connect(micGainNode);
    }
  };
  setMic(mic);

  // DUCKING. Tap the mic branch's own gain node (post-gain, so a quiet mic
  // gain still ducks proportionally) with an analyser and poll its RMS.
  // Guarded: a context that cannot build an AnalyserNode just skips this —
  // the mix still works, it just does not duck.
  let ducked = false;
  let lastLoudAt = 0;
  const applyDisplayGain = (immediate: boolean) => {
    const target = ducked ? baseDisplayGain * DUCK_FACTOR : baseDisplayGain;
    if (immediate) {
      displayGainNode.gain.value = target;
    } else {
      displayGainNode.gain.setTargetAtTime(
        target,
        context.currentTime,
        ducked ? DUCK_ATTACK_SECONDS : DUCK_RELEASE_SECONDS,
      );
    }
  };

  let duckInterval: ReturnType<typeof setInterval> | null = null;
  const analyser = context.createAnalyser?.();
  if (analyser) {
    micGainNode.connect(analyser);
    const bufferSize = analyser.fftSize > 0 ? analyser.fftSize : 2048;
    const buffer = new Float32Array(bufferSize);
    duckInterval = setInterval(() => {
      if (!micSource) {
        // No mic in the mix right now: nothing to duck for.
        if (ducked) {
          ducked = false;
          applyDisplayGain(false);
        }
        return;
      }
      analyser.getFloatTimeDomainData(buffer);
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i++) {
        sumSquares += buffer[i] * buffer[i];
      }
      const rms = Math.sqrt(sumSquares / buffer.length);
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
      const loud = dbfs > DUCK_THRESHOLD_DBFS;
      const now = Date.now();
      if (loud) {
        lastLoudAt = now;
        if (!ducked) {
          ducked = true;
          applyDisplayGain(false);
        }
      } else if (ducked && now - lastLoudAt >= DUCK_RELEASE_HOLD_MS) {
        ducked = false;
        applyDisplayGain(false);
      }
    }, DUCK_POLL_MS);
  }

  const stream = new MediaStream([
    ...display.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);

  return {
    stream,
    setMic,
    micIn: () => micSource !== null,
    setMicGain: (value: number) => {
      micGainNode.gain.value = clamp(value, MIC_GAIN_RANGE);
    },
    setDisplayGain: (value: number) => {
      baseDisplayGain = clamp(value, DISPLAY_GAIN_RANGE);
      applyDisplayGain(true);
    },
    close: () => {
      if (duckInterval !== null) {
        clearInterval(duckInterval);
        duckInterval = null;
      }
      micSource?.disconnect();
      displaySource?.disconnect();
      micGainNode.disconnect();
      displayGainNode.disconnect();
      compressor.disconnect();
      analyser?.disconnect();
      micSource = null;
      displaySource = null;
      for (const track of destination.stream.getAudioTracks()) {
        track.stop();
      }
      void context.close();
    },
  };
}

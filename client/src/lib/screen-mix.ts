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
 *
 * THE OUTPUT METER (2026-09-13, postmortem B2). Three silent stretches on
 * 2026-09-12 had the host panel reading "the window's + your mic" while -91
 * dB actually left the machine: `hasAudio` only knows a track exists, never
 * whether it is carrying anything, and nothing else in either the host's or
 * the room's own experience can see a track that publishes and then goes
 * quiet. `outputLevelDb` taps the bus AFTER the limiter, at the exact point
 * the egress subscribes to, with its OWN analyser rather than the ducking one
 * above: the two answer different questions from different points in the
 * graph (one branch's level vs. the whole mix's), and summing them onto one
 * node's input would corrupt both readings.
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
/** How often the output meter samples the bus, in ms. Same cadence as ducking. */
const OUTPUT_LEVEL_POLL_MS = 50;

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
  /**
   * The mic branch's live level in dBFS, for the mixer's meter. Reuses the
   * ducking analyser below rather than standing up a second one; `null`
   * when there is no analyser (guarded context) or no mic in the mix.
   */
  micLevelDb(): number | null;
  /**
   * A SECOND stream carrying the mic branch alone, for the watch-party
   * archive (`LIVE_HLS_MIC_ARCHIVE`). Null when this context cannot build one.
   *
   * Tapped at `micGain`, which is deliberate on both counts. Post-gain, so
   * what is recorded is what went into the mix rather than a quieter twin
   * nobody would be able to line up with it. And downstream of the pipeline,
   * whose output is already past the mute gate, so the host's mute button
   * mutes the recording exactly as it mutes the stream — there is no second
   * switch to forget.
   *
   * NOT the compressor's output: that bus carries the film as well, and the
   * entire point of the archive is a voice track with no film on it.
   *
   * Idempotent: the same stream comes back on every call, so a caller that
   * asks twice publishes one track rather than two.
   */
  micArchiveStream(): MediaStream | null;
  /**
   * The MIXED BUS's live level in dBFS, post-limiter — what actually leaves
   * on the wire, not what any one branch is contributing. `null` while there
   * is no analyser (guarded context) or nothing has been sampled yet; a real
   * reading can be `-Infinity` (true digital silence), which callers must NOT
   * fold into `null` the way `micLevelDb`'s meter does — collapsing the two
   * is exactly the bug this exists to catch. See the module doc and
   * `watch-party-output-silence.ts`.
   */
  outputLevelDb(): number | null;
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

  // OUTPUT METER. A second, independent analyser at the point the egress
  // actually subscribes to: post-limiter, pre-destination. IN-LINE for the
  // same reason as the ducking analyser below: only a node in the path that
  // reaches `destination` is guaranteed a pull every render quantum, so this
  // sits directly in the bus rather than hanging off to one side. It is a
  // pass-through node, so this changes nothing about what the audience
  // hears. A context that cannot build one just connects the compressor
  // straight through, exactly as before this existed.
  let lastOutputDbfs: number | null = null;
  let outputInterval: ReturnType<typeof setInterval> | null = null;
  const outputAnalyser = context.createAnalyser?.();
  if (outputAnalyser) {
    compressor.connect(outputAnalyser);
    outputAnalyser.connect(destination);
    const outputBufferSize =
      outputAnalyser.fftSize > 0 ? outputAnalyser.fftSize : 2048;
    const outputBuffer = new Float32Array(outputBufferSize);
    outputInterval = setInterval(() => {
      outputAnalyser.getFloatTimeDomainData(outputBuffer);
      let sumSquares = 0;
      for (let i = 0; i < outputBuffer.length; i++) {
        sumSquares += outputBuffer[i] * outputBuffer[i];
      }
      const rms = Math.sqrt(sumSquares / outputBuffer.length);
      // Deliberately NOT folded to `null` on `-Infinity` the way the mic
      // meter folds its own reading: true digital silence is exactly the
      // fact this exists to report, and collapsing it into "nothing
      // measured" would erase the one signal that matters.
      lastOutputDbfs =
        rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
    }, OUTPUT_LEVEL_POLL_MS);
  } else {
    compressor.connect(destination);
  }

  const displayGainNode = context.createGain();
  let baseDisplayGain = clamp(initialLevels.displayGain, DISPLAY_GAIN_RANGE);
  displayGainNode.gain.value = baseDisplayGain;
  displayGainNode.connect(compressor);

  const micGainNode = context.createGain();
  micGainNode.gain.value = clamp(initialLevels.micGain, MIC_GAIN_RANGE);
  // Wired to the compressor below, either directly or through the analyser
  // (see the ducking setup) — never left both connected, which would sum
  // the mic branch onto the bus twice.

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
  // The mixer's level meter reads this rather than re-deriving RMS itself —
  // one analyser, one poll loop, two consumers.
  let lastMicDbfs: number | null = null;
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
    // IN-LINE, not a side tap. An AudioNode with no path to the
    // destination has no standing guarantee it gets pulled every render
    // quantum (the spec's processing model is destination-driven, and an
    // unreferenced branch is fair game to skip or garbage-collect) — a
    // `getFloatTimeDomainData` read against a node like that can go stale
    // silently, which is a bug ducking would never catch since it degrades
    // to "never ducks" rather than throwing. So the analyser sits directly
    // in the mic branch's own signal path, passing the audio through
    // unchanged: `micGain -> analyser -> compressor` instead of
    // `micGain -> compressor` with the analyser hanging off to one side.
    // Being upstream of the bus that reaches `destination` is what makes it
    // "connected" in the spec's sense, and it is a pass-through node, so
    // this changes nothing about what the audience hears.
    micGainNode.connect(analyser);
    analyser.connect(compressor);
    const bufferSize = analyser.fftSize > 0 ? analyser.fftSize : 2048;
    const buffer = new Float32Array(bufferSize);
    duckInterval = setInterval(() => {
      if (!micSource) {
        // No mic in the mix right now: nothing to duck for, and nothing for
        // the meter to show either.
        lastMicDbfs = null;
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
      lastMicDbfs = dbfs;
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
  } else {
    // No analyser available (a fake context in a test, or a browser that
    // refused to build one): nothing to insert, so the mic branch goes
    // straight to the bus as before.
    micGainNode.connect(compressor);
  }

  const stream = new MediaStream([
    ...display.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);

  // Built on demand, not up front: a deployment with the archive off (every
  // deployment, until an operator sets `LIVE_HLS_MIC_ARCHIVE`) must not pay
  // for a second destination node on every share.
  let archive: { stream: MediaStream } & AudioNodeLike | null = null;

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
    micLevelDb: () =>
      lastMicDbfs !== null && Number.isFinite(lastMicDbfs) ? lastMicDbfs : null,
    micArchiveStream: () => {
      if (!archive) {
        try {
          archive = context.createMediaStreamDestination();
          micGainNode.connect(archive);
        } catch {
          // No second destination available here. The share and the stream
          // mix are unaffected; there is simply nothing to record.
          archive = null;
          return null;
        }
      }
      return archive.stream;
    },
    outputLevelDb: () => lastOutputDbfs,
    close: () => {
      if (duckInterval !== null) {
        clearInterval(duckInterval);
        duckInterval = null;
      }
      if (outputInterval !== null) {
        clearInterval(outputInterval);
        outputInterval = null;
      }
      micSource?.disconnect();
      displaySource?.disconnect();
      if (archive) {
        for (const track of archive.stream.getAudioTracks()) {
          track.stop();
        }
        archive.disconnect();
        archive = null;
      }
      micGainNode.disconnect();
      displayGainNode.disconnect();
      compressor.disconnect();
      analyser?.disconnect();
      outputAnalyser?.disconnect();
      micSource = null;
      displaySource = null;
      for (const track of destination.stream.getAudioTracks()) {
        track.stop();
      }
      void context.close();
    },
  };
}

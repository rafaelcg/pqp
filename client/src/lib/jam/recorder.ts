import { type MonoChoice, chooseMono, shiftStart } from "./assemble";
import type { JamInput } from "./input";
import type { LatencyResult } from "./latency";
import { takeOffsetMs, wholeMillisecondOffset } from "./placement";
import type { JamPlayer } from "./player";
import { metronomeClick } from "./signals";
import { type CountIn, beatFrames, countInClicks, countInFrames } from "./tempo";
import { type VideoAlignment, type VideoRecording, alignVideoAudio, startVideoRecording } from "./video-take";

/**
 * Recording over the backing. One call starts the capture, the count-in and
 * the backing on frames computed together; `stop()` hands back a take that is
 * already placed on the song.
 *
 * Timeline of a take with a one-bar count-in at 120 BPM (4/4):
 *
 *   frame  T0 ──── capture starts, click 1
 *          T0 + 0.5 s, 1.0 s, 1.5 s: clicks 2, 3, 4
 *          T0 + 2.0 s = F0 ── backing's `fromMs` leaves the graph
 *          ...the player plays...
 *          stop() ── backing stops, capture flushes
 *
 * The take's first sample is stamped T0 (well, the start of the render
 * quantum holding T0), so `placement.ts` puts it at
 * fromMs + (T0 - F0)/sr - roundTrip, i.e. a count-in plus a round trip before
 * `fromMs`. The count-in stays in the file (a pickup note played over it is
 * not lost) and is hidden by `trimStartMs`.
 */

export interface RecordOptions {
  /** Song time where the backing starts, ms. Default 0. */
  fromMs?: number;
  /** Count-in before the backing, or null for none. */
  countIn?: CountIn | null;
  /** A click during the take too (on the same grid as the count-in), or null. Leaks into a microphone. */
  metronome?: { bpm: number; beatsPerBar: number } | null;
  /** The round trip to compensate. From `JamEngine.latency()` or a calibration. */
  latency: LatencyResult;
  /** A camera stream to record alongside, or null. */
  camera?: MediaStream | null;
  videoBitsPerSecond?: number;
  /** Force a MediaRecorder type for the camera (otherwise `VIDEO_MIME_PREFERENCE`). */
  videoMimeType?: string;
  /** Lead before the first click, seconds. Default 0.15. */
  leadSec?: number;
  /**
   * Start the capture and the count-in at exactly this context frame instead
   * of `now + leadSec` (it must still be in the future). For putting a take
   * on a grid the caller already keeps; the end-to-end spec uses it to lock
   * the take to its fake musician's beat.
   */
  captureStartFrame?: number;
}

export interface JamTake {
  /** Mono PCM at `sampleRate`. Sample 0 is the video's time zero when there is a video. */
  samples: Float32Array;
  sampleRate: number;
  /** Song time of sample 0, a whole number of ms. */
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
  latency: Pick<LatencyResult, "roundTripMs" | "method" | "confidence">;
  monoChoice: MonoChoice;
  /** Frames missing between capture chunks (filled with silence). Should be 0. */
  gapFrames: number;
  /** Audio the browser dropped on the way in during the take, ms (Chrome only, else null). */
  inputDroppedMs: number | null;
  video: { blob: Blob; mimeType: string; alignment: VideoAlignment } | null;
  /** Why there is no video although a camera was given (the recorder produced nothing, or failed). */
  videoError: string | null;
  /** Clock facts, for the harness and the tests. */
  clock: { captureStartFrame: number; backingStartFrame: number; fromMs: number; rawOffsetMs: number };
}

export interface RecordingHandle {
  /** Context frame at which the backing's `fromMs` leaves the graph. */
  readonly backingStartFrame: number;
  /** Context frame at which the capture (and the count-in) starts. */
  readonly captureStartFrame: number;
  stop(): Promise<JamTake>;
  cancel(): Promise<void>;
}

export async function startRecording(player: JamPlayer, input: JamInput, options: RecordOptions): Promise<RecordingHandle> {
  const context = player.context;
  if (input.context !== context) throw new Error("jam: the input must be opened on the player's context");
  if (!Number.isFinite(options.latency.roundTripMs)) throw new Error("jam: no usable latency");
  if (context.state !== "running") await context.resume();
  player.pause();
  const sr = context.sampleRate;
  const fromMs = Math.max(0, options.fromMs ?? 0);

  let video: VideoRecording | null = null;
  if (options.camera) {
    // started first and awaited, so its time zero falls before the capture's
    video = await startVideoRecording(context, options.camera, input.track, {
      videoBitsPerSecond: options.videoBitsPerSecond,
      mimeType: options.videoMimeType,
    });
  }

  const droppedBefore = input.droppedInputMs();
  const earliest = Math.round((context.currentTime + 0.05) * sr);
  const t0 =
    options.captureStartFrame !== undefined
      ? Math.max(earliest, Math.round(options.captureStartFrame))
      : Math.round((context.currentTime + (options.leadSec ?? 0.15)) * sr);
  const countFrames = countInFrames(options.countIn ?? null, sr);
  const f0 = t0 + countFrames;

  const clickBus = context.createGain();
  clickBus.connect(context.destination);
  const clickNodes: AudioBufferSourceNode[] = [];
  const a = metronomeClick(sr, true);
  const p = metronomeClick(sr, false);
  const accentBuf = context.createBuffer(1, a.length, sr);
  accentBuf.copyToChannel(a as Float32Array<ArrayBuffer>, 0);
  const plainBuf = context.createBuffer(1, p.length, sr);
  plainBuf.copyToChannel(p as Float32Array<ArrayBuffer>, 0);
  const click = (frame: number, isAccent: boolean) => {
    const node = context.createBufferSource();
    node.buffer = isAccent ? accentBuf : plainBuf;
    node.connect(clickBus);
    node.start(frame / sr);
    clickNodes.push(node);
  };

  input.startCapture(t0);
  for (const c of countInClicks(options.countIn ?? null, sr)) click(t0 + c.frame, c.accent);
  const backingStartFrame = player.startAt(fromMs, f0 / sr, null);

  // the click during the take, scheduled a little ahead on a timer
  let metroTimer: ReturnType<typeof setInterval> | null = null;
  if (options.metronome) {
    const beat = beatFrames(options.metronome.bpm, sr);
    const perBar = options.metronome.beatsPerBar;
    let k = 0;
    const scheduleAhead = () => {
      const horizon = Math.round((context.currentTime + 1.5) * sr);
      while (f0 + k * beat < horizon) {
        click(f0 + k * beat, k % perBar === 0);
        k++;
      }
    };
    scheduleAhead();
    metroTimer = setInterval(scheduleAhead, 250);
  }

  const teardown = () => {
    if (metroTimer) clearInterval(metroTimer);
    for (const n of clickNodes) {
      try {
        n.stop();
      } catch {
        /* never started */
      }
    }
    clickBus.disconnect();
    player.pause();
  };

  return {
    backingStartFrame,
    captureStartFrame: t0,
    async cancel() {
      teardown();
      await input.stopCapture();
      if (video) await video.stop();
    },
    async stop(): Promise<JamTake> {
      teardown();
      const [capture, videoBlob] = await Promise.all([input.stopCapture(), video ? video.stop() : Promise.resolve(null)]);
      if (!capture) throw new Error("jam: nothing was captured");
      const droppedAfter = input.droppedInputMs();
      const mono = chooseMono(capture.channels);
      const rawOffsetMs = takeOffsetMs({
        sampleRate: sr,
        fromMs,
        backingStartFrame,
        captureStartFrame: capture.startFrame,
        roundTripMs: options.latency.roundTripMs,
      });
      let samples = mono.samples;
      let offsetMs = rawOffsetMs;
      let videoOut: JamTake["video"] = null;
      let videoError: string | null = null;
      if (video && (!videoBlob || videoBlob.size === 0)) {
        videoError = `the camera recorder (${video.mimeType || "default type"}) produced an empty file`;
      }
      if (video && videoBlob && videoBlob.size > 0) {
        const expectedZero = Math.round(video.startedAtCtx * sr) - capture.startFrame;
        let alignment: VideoAlignment = {
          zeroFrame: expectedZero,
          method: "timestamp",
          quality: 0,
          timestampGuess: expectedZero,
        };
        try {
          const fileAudio = await context.decodeAudioData(await videoBlob.arrayBuffer());
          alignment = alignVideoAudio(samples, fileAudio.getChannelData(0), sr, expectedZero);
        } catch {
          /* no decodable audio in the file: keep the timestamp estimate */
        }
        samples = shiftStart(samples, alignment.zeroFrame);
        offsetMs += (alignment.zeroFrame / sr) * 1000;
        videoOut = { blob: videoBlob, mimeType: videoBlob.type || video.mimeType, alignment };
      }
      const whole = wholeMillisecondOffset(offsetMs, sr);
      samples = shiftStart(samples, whole.dropFrames);
      offsetMs = whole.offsetMs;
      const durationMs = (samples.length / sr) * 1000;
      const trimStartMs = Math.min(Math.max(0, fromMs - offsetMs), durationMs);
      return {
        samples,
        sampleRate: sr,
        offsetMs,
        trimStartMs,
        trimEndMs: 0,
        durationMs,
        latency: {
          roundTripMs: options.latency.roundTripMs,
          method: options.latency.method,
          confidence: options.latency.confidence,
        },
        monoChoice: mono.choice,
        gapFrames: capture.gapFrames,
        inputDroppedMs: droppedBefore !== null && droppedAfter !== null ? droppedAfter - droppedBefore : null,
        video: videoOut,
        videoError,
        clock: { captureStartFrame: capture.startFrame, backingStartFrame, fromMs, rawOffsetMs },
      };
    },
  };
}

/** A take as an AudioBuffer on `context`, ready for `JamPlayer.addStem`. */
export function takeToBuffer(context: BaseAudioContext, take: Pick<JamTake, "samples" | "sampleRate">): AudioBuffer {
  const buffer = context.createBuffer(1, Math.max(1, take.samples.length), take.sampleRate);
  buffer.copyToChannel(take.samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}

import { locate } from "./xcorr";

/**
 * The camera, recorded beside the PCM take, and the measurement that lines
 * the two up.
 *
 * HOW THE OFFSET IS MEASURED. MediaRecorder starts when it starts: tens to
 * hundreds of milliseconds after `start()`, differently per browser, and it
 * says nothing precise about when its first frame was. So instead of
 * trusting a timestamp, the recorder is given the SAME microphone track the
 * PCM capture uses. MediaRecorder keeps its own audio and video in sync (it
 * is the one thing every implementation is built to do), so finding the
 * file's audio inside our PCM by cross-correlation tells us where the
 * file's time zero sits on our clock, to the sample. The file's own audio is
 * never played (the <video> is always muted); it is only a ruler.
 *
 * The take is then cut so its sample 0 is the video's time zero, and one
 * `offset_ms` places both.
 *
 * Residual error, stated plainly: the camera's own capture latency (sensor
 * to timestamp, often 30 to 100 ms on a webcam) is inside the browser's A/V
 * sync and is not measured here. That is lip-sync territory, a frame or two,
 * not the sample-tight audio alignment.
 */

/**
 * WebM first, MP4 where it is all there is (Safari). MP4 H.264 + AAC is the file
 * every phone plays, and Chromium can record it, so why not ask for it first?
 * Measured on 2026-11-12 (Playwright's Chromium 151, macOS; the rig is
 * `e2e/jam/av-skew.spec.ts`, the write-up docs/JAM_ENGINE.md), three reasons:
 *
 *   1. THE ALIGNMENT IS BIASED BY AAC'S PRIMING. Chrome's MP4 (a fragmented
 *      file) has no edit list, and its audio track starts with the encoder's
 *      priming (about 44 ms), so the audio sits 30 to 40 ms later against the
 *      picture than in the same take recorded as WebM, where Opus's pre-skip
 *      is honoured. The content method below finds where the file's DECODED
 *      audio starts and calls that the video's time zero, which is right for
 *      WebM and 30 to 40 ms early for this MP4: the picture would lead the sound by
 *      about a frame, and nothing in our own check can see it (it measures
 *      the file against itself). The priming differs per platform's encoder
 *      (AudioToolbox, Media Foundation, ffmpeg), so it cannot be a constant.
 *   2. Chromium's MP4 recorder fails at start (`Internal Error`, the recorder
 *      goes inactive in the same tick as `start`) when it is given an audio
 *      bitrate (see `startOne`), which is what handed back EMPTY files on
 *      2026-11-09. That is fixed, and `startVideoRecording` also notices a
 *      recorder that fails as it starts and falls to the next type, so a
 *      configuration nobody tested costs a type and not the picture.
 *   3. It is not needed: the worker makes the MP4 copy iOS plays from the
 *      WebM (`services/jam-video-transcode.ts`), carrying the time zero over
 *      exactly (pinned by `speech/video-transcode.test.ts`).
 *
 * Where WebM cannot be recorded (Safari) the MP4 is all there is, and that is
 * what the MP4 entries serve. Whether Safari's MP4 carries its priming in an
 * edit list, as Apple's muxers do, was NOT measured (no Safari here; the
 * av-skew rig is Chromium's today). The bare `video/mp4` is last because Chromium answers it with VP9 in
 * MP4, which no phone plays (the worker converts that too).
 */
export const VIDEO_MIME_PREFERENCE = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];

export function pickVideoMime(isSupported: (t: string) => boolean): string | null {
  for (const t of VIDEO_MIME_PREFERENCE) {
    try {
      if (isSupported(t)) return t;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface VideoRecording {
  mimeType: string;
  /** Context time when MediaRecorder said it had started (the fallback estimate of time zero). */
  startedAtCtx: number;
  stop(): Promise<Blob>;
}

/** How long after `start` a recorder that is going to fail has failed (Chromium's MP4 does it in the same tick). */
const START_SETTLE_MS = 120;

/**
 * Start recording the camera and the take's own microphone track.
 *
 * The types are tried in `VIDEO_MIME_PREFERENCE` order, each one that
 * `isTypeSupported` accepts, and a recorder that errors or goes inactive
 * within `START_SETTLE_MS` of its `start` event is dropped for the next one:
 * Chromium's MP4 recorder does exactly that in some configurations (`Internal
 * Error`), and a take that has not begun yet can still pick another type,
 * where one that fails mid-take could only lose its picture. `options.mimeType`
 * forces one type and no other is tried.
 */
export async function startVideoRecording(
  context: AudioContext,
  camera: MediaStream,
  micTrack: MediaStreamTrack,
  options: { videoBitsPerSecond?: number; mimeType?: string } = {},
): Promise<VideoRecording> {
  const videoTrack = camera.getVideoTracks()[0];
  if (!videoTrack) throw new Error("jam: camera stream has no video track");
  const stream = new MediaStream([videoTrack, micTrack]);
  const candidates = options.mimeType
    ? [options.mimeType]
    : VIDEO_MIME_PREFERENCE.filter((t) => {
        try {
          return MediaRecorder.isTypeSupported(t);
        } catch {
          return false;
        }
      });
  // Nothing on the list is supported: the browser's own default.
  if (candidates.length === 0) candidates.push("");
  let lastError: unknown = null;
  for (const mimeType of candidates) {
    try {
      return await startOne(context, stream, mimeType, options.videoBitsPerSecond ?? 1_500_000);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("jam: the camera recorder could not start");
}

async function startOne(
  context: AudioContext,
  stream: MediaStream,
  mimeType: string,
  videoBitsPerSecond: number,
): Promise<VideoRecording> {
  // The audio bitrate is NOT passed to an MP4 recorder: Chromium fails it
  // with "Internal Error" at start whenever the AAC encoder is given
  // `audioBitsPerSecond` with a 44.1 kHz stereo microphone (measured on
  // 2026-11-12, Chromium 151, three runs each way: with it, every start
  // failed; without, none did), and that failure, not the container, is what
  // handed back EMPTY MP4 files on 2026-11-09. Opus in WebM takes it fine.
  const isMp4 = /^video\/mp4/i.test(mimeType);
  const recorder = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond,
    ...(isMp4 ? {} : { audioBitsPerSecond: 64_000 }),
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  let failure: Error | null = null;
  const startedAtCtx = await new Promise<number>((resolve, reject) => {
    recorder.onstart = () => resolve(context.currentTime);
    recorder.onerror = (e) => {
      failure = (e as unknown as { error?: Error }).error ?? new Error("MediaRecorder error");
      reject(failure);
    };
    recorder.start(1000);
  });
  // Started, and about to say it did not mean it.
  await new Promise((resolve) => setTimeout(resolve, START_SETTLE_MS));
  if (failure || recorder.state !== "recording") {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* already over */
    }
    throw failure ?? new Error(`jam: the camera recorder (${mimeType || "default type"}) stopped as it started`);
  }
  return {
    mimeType: recorder.mimeType || mimeType,
    startedAtCtx,
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" }));
        if (recorder.state === "inactive") resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
        else recorder.stop();
      }),
  };
}

export interface VideoAlignment {
  /** PCM index (in the take as captured) of the video's time zero. May be negative. */
  zeroFrame: number;
  method: "content" | "timestamp";
  /** Correlation quality for "content", 0..1. */
  quality: number;
  /** Where MediaRecorder's start event put time zero, for comparison (frames, same origin). */
  timestampGuess: number;
  /**
   * Why the content method was not used, when `method` is "timestamp": the
   * file or the take is under half a second ("short"), no excerpt of the
   * file fell inside the take by the guess ("no-window"), the correlation
   * found nothing at all ("no-match") or only something weaker than
   * `minQuality` ("weak"), or the file's audio could not be decoded
   * ("decode-failed", set by the recorder). Diagnostics only: nothing
   * branches on it.
   */
  reason?: "short" | "no-window" | "no-match" | "weak" | "decode-failed";
}

/**
 * Find the video file's time zero in the PCM take.
 *
 * `expectedZero` is the timestamp guess (where MediaRecorder said it
 * started); the search runs `windowSec` (0.75 s) either side of it, over a few
 * seconds of the file's loudest audio, so it is a 2^19-point FFT and not a
 * correlation of two five-minute files.
 */
export function alignVideoAudio(
  pcm: Float32Array,
  fileAudio: Float32Array,
  sampleRate: number,
  expectedZero: number,
  options: { excerptSec?: number; windowSec?: number; minQuality?: number } = {},
): VideoAlignment {
  const guess = Math.round(expectedZero);
  const fallback: VideoAlignment = { zeroFrame: guess, method: "timestamp", quality: 0, timestampGuess: guess };
  const excerptLen = Math.round((options.excerptSec ?? 3) * sampleRate);
  const window = Math.round((options.windowSec ?? 0.75) * sampleRate);
  const minQuality = options.minQuality ?? 0.5;
  if (fileAudio.length < sampleRate * 0.5 || pcm.length < sampleRate * 0.5) {
    return { ...fallback, reason: "short" };
  }
  // The loudest excerpt of the file that also falls inside the PCM by the
  // guess. Energy is summed once per 250 ms block (a few thousand numbers
  // for a long take, not one per sample) and a window's energy is a sum of
  // consecutive blocks, so the scan is linear and its memory small. A short
  // take gets shorter excerpts (down to half a second) before giving up on
  // content.
  const hop = Math.max(1, Math.round(sampleRate * 0.25));
  const blocks = new Float64Array(Math.ceil(fileAudio.length / hop));
  for (let i = 0; i < fileAudio.length; i++) blocks[(i / hop) | 0] += fileAudio[i] * fileAudio[i];
  // THE EXCERPT MUST FIT INSIDE THE TAKE WITH `window` TO SPARE, because the
  // guess is only a guess: when it is late by 100 ms and the excerpt sits
  // 50 ms into the take, the true position is 50 ms BEFORE the take's first
  // sample and the needle is half outside the haystack, so the correlation
  // collapses to about zero and the alignment silently falls back to the very
  // guess that was wrong (the camera test failed this way once on CI, method
  // "timestamp", quality 0, the guess 107 ms off; docs/JAM_ENGINE.md). With
  // the margin the true position is always inside. A take too short for any
  // margin is tried again with none, which is better than no content match.
  const pickExcerpt = (margin: number): { start: number; len: number } | null => {
    let span = Math.min(Math.floor(excerptLen / hop), Math.floor(fileAudio.length / hop));
    let len = span * hop;
    while (len >= sampleRate * 0.5) {
      let best = -1;
      let bestEnergy = 0;
      let e = 0;
      for (let b = 0; b < span; b++) e += blocks[b];
      for (let b = 0; b + span <= blocks.length; b++) {
        if (b > 0) e += (blocks[b + span - 1] ?? 0) - blocks[b - 1];
        const s = b * hop;
        if (s + len > fileAudio.length) break;
        const pcmAt = expectedZero + s;
        if (pcmAt - margin < 0 || pcmAt + len + margin > pcm.length) continue;
        if (e > bestEnergy) {
          bestEnergy = e;
          best = s;
        }
      }
      if (best >= 0) return { start: best, len };
      span = Math.floor(span / 2);
      len = span * hop;
    }
    return null;
  };
  const excerpt = pickExcerpt(window) ?? pickExcerpt(0);
  if (!excerpt) return { ...fallback, reason: "no-window" };
  const { start: bestStart, len } = excerpt;
  const needle = fileAudio.subarray(bestStart, bestStart + len);
  const hayStart = Math.max(0, Math.round(expectedZero + bestStart - window));
  const hayEnd = Math.min(pcm.length, Math.round(expectedZero + bestStart + len + window));
  const match = locate(pcm.subarray(hayStart, hayEnd), needle, { prefer: expectedZero + bestStart - hayStart });
  if (!match || match.quality < minQuality) {
    return { ...fallback, quality: match?.quality ?? 0, reason: match ? "weak" : "no-match" };
  }
  return {
    zeroFrame: hayStart + match.position - bestStart,
    method: "content",
    quality: match.quality,
    timestampGuess: guess,
  };
}

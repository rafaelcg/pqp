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
 * WebM first, MP4 for Safari (which records nothing else). MP4 would be the
 * better file for the native iOS player, but Chromium's MP4 recorder handed
 * back EMPTY files in about half of a run of short takes in our tests
 * (Playwright's Chromium, fake camera, 2026-11-09) while WebM never did. A
 * WebM camera file needs a transcode before AVFoundation can play it; see
 * docs/JAM_ENGINE.md.
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

export async function startVideoRecording(
  context: AudioContext,
  camera: MediaStream,
  micTrack: MediaStreamTrack,
  options: { videoBitsPerSecond?: number; mimeType?: string } = {},
): Promise<VideoRecording> {
  const videoTrack = camera.getVideoTracks()[0];
  if (!videoTrack) throw new Error("jam: camera stream has no video track");
  const stream = new MediaStream([videoTrack, micTrack]);
  const mimeType = options.mimeType ?? pickVideoMime((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const recorder = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: options.videoBitsPerSecond ?? 1_500_000,
    audioBitsPerSecond: 64_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const startedAtCtx = await new Promise<number>((resolve, reject) => {
    recorder.onstart = () => resolve(context.currentTime);
    recorder.onerror = (e) => reject((e as unknown as { error?: Error }).error ?? new Error("MediaRecorder error"));
    recorder.start(1000);
  });
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
  if (fileAudio.length < sampleRate * 0.5 || pcm.length < sampleRate * 0.5) return fallback;
  // The loudest excerpt of the file that also falls inside the PCM by the
  // guess, scored from a prefix sum of energy so the scan is linear in the
  // take's length. A short take gets shorter excerpts (down to half a
  // second) before giving up on content.
  const prefix = new Float64Array(fileAudio.length + 1);
  for (let i = 0; i < fileAudio.length; i++) prefix[i + 1] = prefix[i] + fileAudio[i] * fileAudio[i];
  const hop = Math.round(sampleRate * 0.25);
  let len = Math.min(excerptLen, fileAudio.length);
  let bestStart = -1;
  let bestEnergy = 0;
  while (bestStart < 0 && len >= sampleRate * 0.5) {
    for (let s = 0; s + len <= fileAudio.length; s += hop) {
      const pcmAt = expectedZero + s;
      if (pcmAt < 0 || pcmAt + len > pcm.length) continue;
      const e = prefix[s + len] - prefix[s];
      if (e > bestEnergy) {
        bestEnergy = e;
        bestStart = s;
      }
    }
    if (bestStart < 0) len = Math.floor(len / 2);
  }
  const needle = fileAudio.subarray(bestStart, bestStart + len);
  const hayStart = Math.max(0, Math.round(expectedZero + bestStart - window));
  const hayEnd = Math.min(pcm.length, Math.round(expectedZero + bestStart + len + window));
  const match = locate(pcm.subarray(hayStart, hayEnd), needle, { prefer: expectedZero + bestStart - hayStart });
  if (!match || match.quality < minQuality) return { ...fallback, quality: match?.quality ?? 0 };
  return {
    zeroFrame: hayStart + match.position - bestStart,
    method: "content",
    quality: match.quality,
    timestampGuess: guess,
  };
}

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { TranscodeError, UnsupportedContainerError, videoDemuxerFor } from "./transcode.js";

/**
 * The MP4 copy of a Jam camera video, for the players that cannot play WebM
 * (AVPlayer on iOS, Safari). Chrome records VP8/VP9 + Opus in WebM; the copy is
 * H.264 + AAC in a `+faststart` MP4 that every phone and browser plays.
 *
 * WHAT HAS TO SURVIVE: the take's audio is aligned to the VIDEO's time zero
 * (`client/src/lib/jam/video-take.ts`: one `offset_ms` places both), so the
 * copy must start where the original starts and be as long as it is. Concretely
 *
 *   * no trimming of leading silence and no `-ss`, no `-shortest`, no
 *     `-af apad`, nothing that moves the first audio sample or the first frame;
 *   * the first frame keeps its presentation time and the first audio sample
 *     its own (ffmpeg's mov muxer writes both starts, and the AAC encoder's
 *     priming, into the edit list, which AVPlayer, Safari and Chrome honour);
 *   * a constant frame rate (`-fps_mode cfr -r 30`): MediaRecorder's picture
 *     is variable frame rate, which some phone players scrub badly. CFR
 *     duplicates and drops frames, never shifts them.
 *
 * `server/src/speech/video-transcode.test.ts` pins it with a flash on frame N
 * and a click at the same instant, found again in the output.
 *
 * ffmpeg runs only in the worker image (`Dockerfile`, target `worker`), with
 * its libx264 and native AAC encoders; `isJamTranscodeAvailable` is the check
 * `runnableSpeechJobKinds` makes, so a process without them never claims the
 * job and leaves it queued for one that can.
 */

const FFMPEG = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";

/** A video pass is minutes at most for a 100 MiB file; a hung process is not. */
export const JAM_TRANSCODE_TIMEOUT_MS = 10 * 60_000;

let encoders: Promise<boolean> | null = null;

/** Whether `ffmpeg` runs here with the libx264 and AAC encoders. Asked once per process. */
export function isJamTranscodeAvailable(): Promise<boolean> {
  encoders ??= new Promise<boolean>((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(FFMPEG(), ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && /\blibx264\b/.test(out) && /\baac\b/.test(out));
    });
  });
  return encoders;
}

/** Tests only. */
export function resetJamTranscodeAvailabilityForTests(): void {
  encoders = null;
}

// ---------------------------------------------------------------- inspecting

export interface Mp4Facts {
  /** `moof` boxes follow the `moov`: MediaRecorder's output, which phone players scrub badly. */
  fragmented: boolean;
  /** The `moov` is ahead of the `mdat`: a player can start before the last byte arrives. */
  faststart: boolean;
  /** An `avc1`/`avc3` sample entry (H.264). */
  h264: boolean;
  /** An `mp4a` sample entry (AAC). Absent is fine: a video with no sound needs none. */
  aac: boolean;
  /** Some other video or audio sample entry that a phone cannot be trusted with (VP9, AV1, Opus...). */
  otherCodec: boolean;
}

/** What an iOS player needs from an MP4, from its top-level boxes and its sample entries. */
export async function inspectMp4File(path: string): Promise<Mp4Facts | null> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(16);
    let offset = 0;
    let moovAt = -1;
    let moovSize = 0;
    let mdatAt = -1;
    let fragmented = false;
    for (let boxes = 0; offset + 8 <= size && boxes < 200; boxes++) {
      const { bytesRead } = await handle.read(head, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(head.readBigUInt64BE(8));
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (boxSize < 8) return null;
      if (type === "moov" && moovAt < 0) {
        moovAt = offset;
        moovSize = boxSize;
      } else if (type === "mdat" && mdatAt < 0) {
        mdatAt = offset;
      } else if (type === "moof") {
        fragmented = true;
      }
      offset += boxSize;
    }
    if (moovAt < 0) return null;
    // The sample entries live inside the moov (stsd); a four-character search
    // of it is enough to name them and cheap. A moov of 16 MiB is not a camera clip.
    const read = Math.min(moovSize, 16 * 1024 * 1024);
    const moov = Buffer.alloc(read);
    await handle.read(moov, 0, read, moovAt);
    const has = (code: string) => moov.includes(code, 0, "latin1");
    const h264 = has("avc1") || has("avc3");
    const aac = has("mp4a");
    const otherCodec = ["vp09", "vp08", "av01", "hvc1", "hev1", "Opus", "opus", "fLaC", "ac-3", "ec-3"].some(has);
    return { fragmented, faststart: mdatAt < 0 || moovAt < mdatAt, h264, aac, otherCodec };
  } finally {
    await handle.close();
  }
}

/** What the worker does with a recorded file. */
export type VideoPlan = "none" | "remux" | "transcode";

/**
 * `none`: the file already is what a phone plays (H.264 + AAC, `moov` first, not
 * fragmented), nothing is made. `remux`: right codecs in a wrapper a phone is
 * unsure of (MediaRecorder's fragmented MP4): the streams are copied, no
 * re-encode. `transcode`: anything else.
 */
export function planFor(demuxer: "mov" | "matroska", facts: Mp4Facts | null): VideoPlan {
  if (demuxer === "matroska" || !facts) return "transcode";
  if (!facts.h264 || facts.otherCodec) return "transcode";
  if (!facts.fragmented && facts.faststart) return "none";
  return "remux";
}

// ---------------------------------------------------------------- the pass

async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Which demuxer the file may use, or throws `UnsupportedContainerError` (see `videoDemuxerFor`). */
export async function demuxerOf(path: string): Promise<"mov" | "matroska"> {
  const demuxer = videoDemuxerFor(await readHead(path, 16));
  if (!demuxer) throw new UnsupportedContainerError("not an MP4 or WebM file");
  return demuxer;
}

/** The video bitrate ceiling: a 100 MiB output is a quarter of an hour at this, past any take. */
const MAX_RATE = "1800k";

function args(inputPath: string, outputPath: string, demuxer: "mov" | "matroska", plan: "remux" | "transcode"): string[] {
  const input = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    // The demuxer is named and nothing but a local file may be opened: see `videoDemuxerFor`.
    "-protocol_whitelist",
    "file",
    "-f",
    demuxer,
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
  ];
  const output = ["-movflags", "+faststart", "-f", "mp4", "-y", outputPath];
  if (plan === "remux") {
    return [...input, "-c", "copy", ...output];
  }
  return [
    ...input,
    "-c:v",
    "libx264",
    "-profile:v",
    "main",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    MAX_RATE,
    "-bufsize",
    "3600k",
    // Even sides, which yuv420p requires.
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-fps_mode",
    "cfr",
    "-r",
    "30",
    // Two threads: this shares a box with the other jobs.
    "-threads",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    ...output,
  ];
}

/**
 * `ffmpeg -f <demuxer> -i in -map 0:v:0 -map 0:a:0? -c:v libx264 ... out.mp4`.
 * Through files, not pipes: `+faststart` rewrites the file after the encode.
 */
export async function convertVideoToMp4(
  inputPath: string,
  outputPath: string,
  demuxer: "mov" | "matroska",
  plan: "remux" | "transcode",
  timeoutMs = JAM_TRANSCODE_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG(), args(inputPath, outputPath, demuxer, plan), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new TranscodeError(error.message));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new TranscodeError(`ffmpeg exited ${signal ?? code}: ${stderr.trim()}`));
    });
  });
}

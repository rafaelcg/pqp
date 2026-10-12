import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The AAC copy of an Opus voice note, for the players that cannot play Opus
 * (iOS's AVPlayer, older Safari). One ffmpeg run:
 *
 *   ffmpeg -i in -vn -ac 1 -c:a aac -b:a 48k -movflags +faststart out.m4a
 *
 * Through temporary FILES, not pipes: `+faststart` moves the `moov` box to the
 * front after the encode, which needs a seekable output, and that is the whole
 * point of it (a player can start before the last byte arrives).
 *
 * ffmpeg is in the WORKER image only (`Dockerfile`, target `worker`). A
 * process without it never claims a transcode job (`isFfmpegAvailable`), so
 * the API container, a Fly worker built from the API image, or a laptop
 * without ffmpeg leaves the jobs queued for a process that can run them,
 * rather than failing them.
 */

const FFMPEG = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";
/** A five minute note encodes in a couple of seconds; this is a hung process. */
const TRANSCODE_TIMEOUT_MS = 60_000;
/** Output is ~6 KB/s at 48 kbps; five minutes is under 2 MB. Anything past this is wrong. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

let availability: Promise<boolean> | null = null;

/** Whether `ffmpeg` runs here and has the native AAC encoder. Asked once per process. */
export function isFfmpegAvailable(): Promise<boolean> {
  availability ??= new Promise<boolean>((resolve) => {
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
      resolve(code === 0 && /\baac\b/.test(out));
    });
  });
  return availability;
}

/** Tests only. */
export function resetFfmpegAvailabilityForTests(): void {
  availability = null;
}

export class TranscodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscodeError";
  }
}

/** Opus (or anything ffmpeg reads) in, mono AAC-LC 48 kbps in a faststart MP4 out. */
export async function transcodeToAac(input: Uint8Array, inputExtension: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "pqp-transcode-"));
  const inPath = join(dir, `in${inputExtension}`);
  const outPath = join(dir, "out.m4a");
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        FFMPEG(),
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          inPath,
          "-vn",
          "-ac",
          "1",
          "-c:a",
          "aac",
          "-b:a",
          "48k",
          "-movflags",
          "+faststart",
          "-f",
          "mp4",
          "-y",
          outPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-500);
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), TRANSCODE_TIMEOUT_MS);
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
    const output = await readFile(outPath);
    if (output.length === 0 || output.length > MAX_OUTPUT_BYTES) {
      throw new TranscodeError(`ffmpeg produced ${output.length} bytes`);
    }
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The uploaded file is not an MP4 or a WebM, whatever its name and its signed type said. */
export class UnsupportedContainerError extends TranscodeError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedContainerError";
  }
}

/**
 * Which demuxer ffmpeg is allowed to use for an uploaded video, from its first
 * bytes: an ISO BMFF box (`ftyp` at offset 4) is `mov` (MP4), an EBML header
 * is `matroska` (WebM). Anything else is refused before ffmpeg runs.
 *
 * This is a security boundary, not a nicety. Left to probe, ffmpeg reads a
 * text file that looks like an HLS or concat playlist and then OPENS the URLs
 * inside it, so an uploader could make the worker fetch an internal address.
 * Naming the demuxer stops the probe, and `-protocol_whitelist file` stops
 * anything the demuxer itself would open (an MP4's external data references,
 * for example) from leaving the local file.
 */
export function videoDemuxerFor(head: Uint8Array): "mov" | "matroska" | null {
  const b = Buffer.from(head);
  if (b.length >= 8 && b.toString("ascii", 4, 8) === "ftyp") return "mov";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "matroska";
  return null;
}

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

/** 16 kHz, mono, signed 16-bit little endian: what Whisper resamples to anyway. */
export const PCM16K_BYTES_PER_SECOND = 16_000 * 2;

/**
 * The sound of a video as raw PCM, for automatic subtitles
 * (`services/community-home-captions-worker.ts`):
 *
 *   ffmpeg -protocol_whitelist file -f <mov|matroska> -i video
 *          -map 0:a:0 -vn -ac 1 -ar 16000 -t <max> -f s16le out.pcm
 *
 * Raw samples and no container on purpose: the length is the file size, a
 * window is a byte range, and turning one into a WAV is a 44 byte header
 * (`pcmToWav`), so the job never runs ffmpeg again per window and never holds
 * the whole track in memory. A video with no audio stream fails here (ffmpeg
 * says so), which the job treats as "nothing to caption".
 */
export async function extractPcm16k(
  inputPath: string,
  outputPath: string,
  maxSeconds: number,
  timeoutMs = 5 * 60_000,
): Promise<{ durationMs: number; bytes: number }> {
  const demuxer = videoDemuxerFor(await readHead(inputPath, 16));
  if (!demuxer) {
    throw new UnsupportedContainerError("not an MP4 or WebM file");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      FFMPEG(),
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-f",
        demuxer,
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-t",
        String(Math.max(1, Math.floor(maxSeconds))),
        "-f",
        "s16le",
        "-y",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
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
  const { size } = await stat(outputPath);
  return { durationMs: Math.floor((size / PCM16K_BYTES_PER_SECOND) * 1000), bytes: size };
}

/** A RIFF/WAVE header in front of 16 kHz mono s16le samples. */
export function pcmToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

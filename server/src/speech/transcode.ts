import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

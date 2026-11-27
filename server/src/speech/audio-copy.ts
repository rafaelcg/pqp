import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { JAM_AUDIO_MAX_BYTES } from "@pqp/shared";
import { TranscodeError } from "./transcode.js";

/**
 * The OPUS LISTENING COPY of a Jam stem. The recorded FLAC is the source of
 * truth (the studio records against it, an export is made from it); the copy
 * exists so a person who only LISTENS, on the public site or in the app's public
 * view, does not download 3.5 MB per stem-minute of FLAC before the first sound.
 *
 * WHAT HAS TO SURVIVE is time, exactly as for the MP4 copy of a camera video
 * (`video-transcode.ts`): the engine places a stem by `offsetMs` and trims, in
 * sample frames, against a decoded `AudioBuffer`. A copy that starts 6.5 ms
 * late (an Opus encoder's look-ahead, which every Opus file begins with) puts
 * every part of a song out of step with the others, and so does a copy whose
 * length differs from the original's by a codec frame. Two facts make Opus fit:
 *
 *   * the encoder's delay is not hidden, it is DECLARED: the `OpusHead` packet
 *     carries `pre-skip` (312 samples at 48 kHz for libopus at 20 ms frames)
 *     and every decoder drops exactly that many samples (measured on the real
 *     decoders: Chromium, Firefox and WebKit all place a click at the same
 *     sample as the FLAC, `docs/JAM_ENGINE.md`), and the Ogg muxer states the
 *     END too, through the last page's granule position, so the decoded length
 *     is the original's to the sample;
 *   * so nothing here trims, pads or shifts: no `-ss`, no `-af apad`, no
 *     `-shortest`, no `atrim`. The job then CHECKS the claim on the file it
 *     just made (`copyLengthProblem`): pre-skip and last granule against the
 *     FLAC's own sample count. A copy whose length is not the original's is not
 *     offered, it is a failure that shows on the dashboard.
 *
 * `audio-copy.test.ts` pins it on real ffmpeg: a click track encoded from the
 * FLAC and from the copy, mixed, with the onsets found again and compared.
 *
 * Only LOSSLESS originals are copied (`audio/flac`, what the web recorder
 * sends): a phone's AAC, Opus or MP3 is already 1.4 MB per minute at most, and
 * decoders disagree about the delay of those formats (a WebKit MP3 moved 12 ms
 * in `docs/JAM_ENGINE.md`), so an ffmpeg-made copy could be right where the
 * browser's own decode of the original is not.
 *
 * ffmpeg runs only in the worker image (`Dockerfile`, target `worker`), and
 * only with libopus; `isJamAudioCopyAvailable` is what the claim asks, so a
 * process without it never takes the job and leaves it queued.
 */

const FFMPEG = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";

/** Opus is 48 kHz inside; a stem at another rate is resampled by the encoder, and decoded to the context's rate anyway. */
export const LISTEN_COPY_SAMPLE_RATE = 48_000;
/**
 * Bits per second per channel. Chosen by measurement on a five-stem mix
 * (`docs/JAM_ENGINE.md`, "The listening copy"): 64 kbps is the lowest rate at
 * which the SUM of five decoded copies did not overshoot the sum of the
 * originals (32 kbps clipped by 45 %, 48 kbps touched full scale) and its
 * third-octave envelope stayed within 0.75 dB; 96 kbps buys 0.2 dB more for 45
 * % more bytes on a link where bytes are the whole problem.
 */
export const LISTEN_COPY_BITRATE_PER_CHANNEL = 64_000;
/** Longest pass: a stem is at most ten minutes, and Opus encodes at 100x real time or better. */
export const LISTEN_COPY_TIMEOUT_MS = 3 * 60_000;
/** A decode that runs this much past the recorder's `durationMs` is not the file it said. */
const LENGTH_SLACK_SECONDS = 30;
/**
 * What the copy's decoded length may differ from the original's by: one
 * millisecond (48 samples at 48 kHz). ffmpeg's muxer is exact to the sample for a
 * 48 kHz stem and to one sample after resampling a 44.1, 32 or 22.05 kHz one
 * (measured), so this has two orders of magnitude of room, and it is still far
 * under the 312 samples (6.5 ms) of pre-skip that an encoder whose delay was not
 * declared would add: the case this check exists to catch.
 */
export const LENGTH_TOLERANCE_SAMPLES = 48;

export const LISTEN_COPY_CONTENT_TYPE = "audio/ogg";
export const LISTEN_COPY_CODEC = "opus";

let encoders: Promise<boolean> | null = null;

/** Whether `ffmpeg` runs here with the libopus encoder. Asked once per process. */
export function isJamAudioCopyAvailable(): Promise<boolean> {
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
      resolve(code === 0 && /\blibopus\b/.test(out));
    });
  });
  return encoders;
}

/** Tests only. */
export function resetJamAudioCopyAvailabilityForTests(): void {
  encoders = null;
}

// ---------------------------------------------------------------- inspecting

export interface FlacFacts {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 0 when the encoder did not know it (a streamed FLAC). */
  totalSamples: number;
}

/** STREAMINFO, from the first bytes of a FLAC file, or null when it is not one. */
export function readFlacStreamInfo(head: Buffer): FlacFacts | null {
  // "fLaC", then a metadata block header (1 byte: last flag + type, 3 bytes: length); STREAMINFO is type 0, 34 bytes.
  if (head.length < 42 || head.toString("latin1", 0, 4) !== "fLaC") return null;
  if ((head[4]! & 0x7f) !== 0 || head.readUIntBE(5, 3) !== 34) return null;
  const info = head.subarray(8, 42);
  // min/max block size (2+2), min/max frame size (3+3), then 20 bits of sample rate, 3 of channels - 1, 5 of bits - 1, 36 of samples.
  const rateChannelsBits = info.readUIntBE(10, 4);
  const sampleRate = Math.floor(rateChannelsBits / 4096);
  const channels = ((rateChannelsBits >> 9) & 0x7) + 1;
  const bitsPerSample = ((rateChannelsBits >> 4) & 0x1f) + 1;
  const totalSamples = (rateChannelsBits & 0xf) * 2 ** 32 + info.readUInt32BE(14);
  if (sampleRate === 0) return null;
  return { sampleRate, channels, bitsPerSample, totalSamples };
}

async function readRange(path: string, from: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function inspectFlacFile(path: string): Promise<FlacFacts | null> {
  return readFlacStreamInfo(await readRange(path, 0, 64));
}

export interface OggOpusFacts {
  channels: number;
  /** Samples at 48 kHz the decoder drops from the start (the encoder's look-ahead). */
  preSkip: number;
  /** The last page's granule position: samples at 48 kHz, pre-skip included. */
  lastGranule: number;
  /** What a decoder hands back: `lastGranule - preSkip`, at 48 kHz. */
  samples: number;
}

/** `OpusHead` and the last granule position of an Ogg Opus file, or null when it is not one. */
export async function inspectOggOpusFile(path: string): Promise<OggOpusFacts | null> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size < 64) return null;
    const head = Buffer.alloc(Math.min(size, 512));
    await handle.read(head, 0, head.length, 0);
    if (head.toString("latin1", 0, 4) !== "OggS") return null;
    const at = head.indexOf("OpusHead", 0, "latin1");
    if (at < 0 || at + 19 > head.length) return null;
    const channels = head[at + 9]!;
    const preSkip = head.readUInt16LE(at + 10);
    const tailLength = Math.min(size, 65_536);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const page = tail.lastIndexOf("OggS", tail.length - 27, "latin1");
    if (page < 0 || page + 14 > tail.length) return null;
    const lastGranule = Number(tail.readBigInt64LE(page + 6));
    if (lastGranule < 0) return null;
    return { channels, preSkip, lastGranule, samples: Math.max(0, lastGranule - preSkip) };
  } finally {
    await handle.close();
  }
}

/**
 * What is wrong with a finished copy, or null. The check that makes "the delay
 * is compensated" a property of every copy rather than of the encoder version
 * the tests happened to run: the decoded copy must be as long as the original
 * and carry the same channels.
 */
export function copyLengthProblem(original: FlacFacts, copy: OggOpusFacts): string | null {
  if (copy.channels !== original.channels) {
    return `channels ${original.channels} became ${copy.channels}`;
  }
  if (copy.preSkip <= 0 || copy.preSkip > 3_840) {
    return `implausible pre-skip ${copy.preSkip}`;
  }
  if (original.totalSamples > 0) {
    const expected = Math.round((original.totalSamples * LISTEN_COPY_SAMPLE_RATE) / original.sampleRate);
    if (Math.abs(copy.samples - expected) > LENGTH_TOLERANCE_SAMPLES) {
      return `length ${copy.samples} samples, original ${expected}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- the pass

/** The ffmpeg command line, exported so a test can pin the guards it carries. */
export function listenCopyArgs(
  inputPath: string,
  outputPath: string,
  options: { channels: number; maxSeconds: number },
): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    // A named demuxer and nothing but a local file: the bytes are an upload, never probed or followed.
    "-protocol_whitelist",
    "file",
    "-f",
    "flac",
    // A decoder allocation guard, as the video copy's.
    "-max_alloc",
    String(256 * 1024 * 1024),
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-c:a",
    "libopus",
    "-b:a",
    String(LISTEN_COPY_BITRATE_PER_CHANNEL * options.channels),
    "-vbr",
    "on",
    "-application",
    "audio",
    "-compression_level",
    "10",
    "-frame_duration",
    "20",
    "-ar",
    String(LISTEN_COPY_SAMPLE_RATE),
    "-ac",
    String(options.channels),
    // Nothing that moves the first sample or the last one: no -ss, apad, shortest, atrim.
    // A bound on the OUTPUT, so a FLAC that decodes to hours cannot fill the disk or hold the worker.
    "-t",
    String(options.maxSeconds),
    "-fs",
    String(JAM_AUDIO_MAX_BYTES + 1),
    "-threads",
    "2",
    "-f",
    "ogg",
    "-y",
    outputPath,
  ];
}

/** How long a pass may decode: what the recorder said the stem lasts, plus slack. */
export function maxCopySeconds(durationMs: number): number {
  return Math.ceil(durationMs / 1000) + LENGTH_SLACK_SECONDS;
}

/** `ffmpeg -f flac -i in -c:a libopus -b:a 64k ... out.ogg`. Through files: the muxer wants to seek back and write the length. */
export async function convertFlacToListenCopy(
  inputPath: string,
  outputPath: string,
  options: { channels: number; maxSeconds: number },
  timeoutMs = LISTEN_COPY_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG(), listenCopyArgs(inputPath, outputPath, options), {
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

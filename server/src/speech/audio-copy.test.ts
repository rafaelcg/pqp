import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LENGTH_TOLERANCE_SAMPLES,
  LISTEN_COPY_BITRATE_PER_CHANNEL,
  convertFlacToListenCopy,
  copyLengthProblem,
  inspectFlacFile,
  inspectOggOpusFile,
  isJamAudioCopyAvailable,
  listenCopyArgs,
  maxCopySeconds,
  readFlacStreamInfo,
  type FlacFacts,
  type OggOpusFacts,
} from "./audio-copy.js";

/**
 * The Opus listening copy of a Jam stem, on REAL ffmpeg. The claim that matters
 * is not "an Ogg comes out" but "every sound comes out WHERE IT WENT IN": the
 * engine places a stem by milliseconds and trims against a decoded
 * `AudioBuffer`, so a copy that starts an encoder's look-ahead late (6.5 ms for
 * libopus) or ends a frame short puts one part of a song out of step with the
 * rest, for every listener, with nothing on screen to say so.
 *
 * The fixture is a click track: short decaying noise bursts at sample positions
 * that fall on no frame boundary, one of them INSIDE the encoder's pre-skip
 * (sample 40 of 312), at 48 kHz and at 44.1 kHz. The test encodes it to FLAC,
 * makes the copy with the worker's own function, decodes both with ffmpeg's
 * decoder, MIXES three such stems from each, and finds every burst again in the
 * two mixes. The onsets must agree to a tenth of a millisecond and the decoded
 * length to the sample. Browsers' own decoders are measured in
 * `client/e2e/jam/formats.spec.ts`.
 *
 * Skipped where ffmpeg lacks libopus; CI installs a full ffmpeg for it.
 */

const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const available = await isJamAudioCopyAvailable();
const describeFfmpeg = available ? describe : describe.skip;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pqp-jam-audio-copy-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------- fixtures

/** A mono click stem: a decaying burst of noise (deterministic) at each sample position. */
function clickStem(rate: number, seconds: number, at: number[], seed: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  let state = seed;
  const noise = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
  const length = Math.round(rate * 0.004);
  for (const start of at) {
    for (let i = 0; i < length && start + i < out.length; i++) {
      out[start + i] = 0.8 * noise() * Math.exp((-6 * i) / length);
    }
  }
  return out;
}

function pcm16(stem: Float32Array): Buffer {
  const buffer = Buffer.alloc(stem.length * 2);
  for (let i = 0; i < stem.length; i++) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(stem[i]! * 32767))), i * 2);
  }
  return buffer;
}

async function toFlac(name: string, stem: Float32Array, rate: number): Promise<string> {
  const raw = join(dir, `${name}.raw`);
  const flac = join(dir, `${name}.flac`);
  await writeFile(raw, pcm16(stem));
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", raw, "-c:a", "flac", flac]);
  return flac;
}

/** ffmpeg's own decode to 48 kHz mono float, the common ground for comparing. */
function decode(path: string, format: "flac" | "ogg"): Float32Array {
  const result = spawnSync(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-f", format, "-i", path, "-f", "f32le", "-ac", "1", "-ar", "48000", "-"],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  expect(result.status, String(result.stderr)).toBe(0);
  const bytes = result.stdout;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

/**
 * The time of each burst, in samples at 48 kHz: the energy-weighted centroid of
 * the 16 ms around it. Sub-sample, and it does not care that a codec smears a
 * click: only that the smear is centred where the click was.
 */
function onsets(signal: Float32Array, near: number[]): number[] {
  return near.map((center) => {
    const from = Math.max(0, center - 384);
    const to = Math.min(signal.length, center + 384);
    let weight = 0;
    let moment = 0;
    for (let i = from; i < to; i++) {
      const energy = signal[i]! * signal[i]!;
      weight += energy;
      moment += energy * i;
    }
    return weight === 0 ? Number.NaN : moment / weight;
  });
}

function mix(stems: Float32Array[]): Float32Array {
  const length = Math.min(...stems.map((stem) => stem.length));
  const out = new Float32Array(length);
  for (const stem of stems) for (let i = 0; i < length; i++) out[i]! += stem[i]!;
  return out;
}

const COPY_OPTIONS = { channels: 1, maxSeconds: 60 };

// ------------------------------------------------------------------ the pass

describeFfmpeg("the Opus listening copy, on real ffmpeg", () => {
  // Three stems of a song, each with its own clicks (in 48 kHz samples), one
  // within the pre-skip and one hard up against the end.
  const SECONDS = 4;
  const STEMS = [
    { name: "a", rate: 48_000, clicks: [40, 48_000, 120_007, 191_000], seed: 1 },
    { name: "b", rate: 48_000, clicks: [9_001, 71_999, 150_001], seed: 2 },
    { name: "c", rate: 44_100, clicks: [100, 44_100, 100_001, 170_000], seed: 3 },
  ];

  it("a mix of three stems puts every click where the FLAC mix does, and decodes to the same length", async () => {
    const flacs: Float32Array[] = [];
    const copies: Float32Array[] = [];
    const where: number[] = [];
    for (const stem of STEMS) {
      // Clicks are authored in 48 kHz samples; the 44.1 kHz stem needs them at its own rate.
      const positions = stem.clicks.map((at) => Math.round((at * stem.rate) / 48_000));
      const flac = await toFlac(`stem-${stem.name}`, clickStem(stem.rate, SECONDS, positions, stem.seed), stem.rate);
      const ogg = join(dir, `stem-${stem.name}.listen.ogg`);
      const original = await inspectFlacFile(flac);
      expect(original).toMatchObject({ sampleRate: stem.rate, channels: 1, bitsPerSample: 16 });
      await convertFlacToListenCopy(flac, ogg, COPY_OPTIONS);

      const made = await inspectOggOpusFile(ogg);
      expect(made).not.toBeNull();
      // The delay is DECLARED (312 samples for libopus at 20 ms) and the length is the original's.
      expect(made!.preSkip).toBe(312);
      expect(copyLengthProblem(original!, made!)).toBeNull();

      const a = decode(flac, "flac");
      const b = decode(ogg, "ogg");
      // Same number of samples: nothing was trimmed, padded or shifted.
      expect(b.length).toBe(a.length);
      flacs.push(a);
      copies.push(b);
      where.push(...stem.clicks);
    }
    // The MIX: the engine sums stems, so this is what a listener hears.
    const flacMix = mix(flacs);
    const copyMix = mix(copies);
    const near = [...new Set(where)].sort((x, y) => x - y);
    const before = onsets(flacMix, near);
    const after = onsets(copyMix, near);
    if (process.env.AUDIO_COPY_TEST_VERBOSE) {
      const errors = near.map((_at, i) => Number((after[i]! - before[i]!).toFixed(3)));
      console.info("onset error (samples @48k, copy minus FLAC) per click:", JSON.stringify(errors));
    }
    for (let i = 0; i < near.length; i++) {
      // A tenth of a millisecond, 4.8 samples. An undeclared encoder delay would be 312.
      expect(Math.abs(after[i]! - before[i]!), `click near sample ${near[i]}`).toBeLessThan(4.8);
    }
    // The control: the same comparison DOES see an undeclared encoder delay. A copy
    // shifted by libopus's 312 samples fails it by about 312, so a pass above means something.
    const late = new Float32Array(copyMix.length);
    late.set(copyMix.subarray(0, copyMix.length - 312), 312);
    const shifted = onsets(late, near);
    expect(Math.abs(shifted[2]! - before[2]!)).toBeGreaterThan(250);
  });

  it("a stereo FLAC keeps its two channels, at twice the rate", async () => {
    const rate = 48_000;
    const left = clickStem(rate, 3, [100, 30_000, 90_000], 5);
    const right = clickStem(rate, 3, [200, 31_000, 91_000], 6);
    const raw = Buffer.alloc(left.length * 4);
    for (let i = 0; i < left.length; i++) {
      raw.writeInt16LE(Math.round(left[i]! * 32767), i * 4);
      raw.writeInt16LE(Math.round(right[i]! * 32767), i * 4 + 2);
    }
    await writeFile(join(dir, "st.raw"), raw);
    execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", join(dir, "st.raw"), "-c:a", "flac", join(dir, "st.flac")]);
    const original = (await inspectFlacFile(join(dir, "st.flac")))!;
    expect(original.channels).toBe(2);
    await convertFlacToListenCopy(join(dir, "st.flac"), join(dir, "st.listen.ogg"), { channels: 2, maxSeconds: 60 });
    const made = (await inspectOggOpusFile(join(dir, "st.listen.ogg")))!;
    expect(made.channels).toBe(2);
    expect(copyLengthProblem(original, made)).toBeNull();
  });

  it("refuses bytes that are not a FLAC, through the named demuxer", async () => {
    await writeFile(join(dir, "not.flac"), Buffer.from("RIFF....WAVEfmt this is not a flac stream at all"));
    await expect(
      convertFlacToListenCopy(join(dir, "not.flac"), join(dir, "not.ogg"), COPY_OPTIONS),
    ).rejects.toThrow(/ffmpeg exited/);
  });

  it("stops at the bound it was given: a FLAC longer than its stated length is cut, and the length check then fails it", async () => {
    const flac = await toFlac("long", clickStem(48_000, 10, [100], 9), 48_000);
    await convertFlacToListenCopy(flac, join(dir, "long.ogg"), { channels: 1, maxSeconds: 3 });
    const made = (await inspectOggOpusFile(join(dir, "long.ogg")))!;
    expect(made.samples).toBeLessThanOrEqual(3 * 48_000 + 960);
    const original = (await inspectFlacFile(flac))!;
    expect(copyLengthProblem(original, made)).toMatch(/length/);
  });
});

// ------------------------------------------------- no ffmpeg needed below

describe("the copy's checks", () => {
  const original: FlacFacts = { sampleRate: 48_000, channels: 1, bitsPerSample: 16, totalSamples: 480_000 };
  const copy = (patch: Partial<OggOpusFacts> = {}): OggOpusFacts => ({
    channels: 1,
    preSkip: 312,
    lastGranule: 480_312,
    samples: 480_000,
    ...patch,
  });

  it("accepts a copy as long as the original", () => {
    expect(copyLengthProblem(original, copy())).toBeNull();
    // One sample either way is resampling's rounding, not a shift.
    expect(copyLengthProblem(original, copy({ samples: 480_001 }))).toBeNull();
    expect(copyLengthProblem(original, copy({ samples: 480_000 - LENGTH_TOLERANCE_SAMPLES }))).toBeNull();
  });

  it("refuses an encoder delay that nobody declared (312 samples too long) and a short copy", () => {
    expect(copyLengthProblem(original, copy({ samples: 480_312 }))).toMatch(/length 480312/);
    expect(copyLengthProblem(original, copy({ samples: 479_000 }))).toMatch(/length 479000/);
  });

  it("refuses a changed channel count and an implausible pre-skip", () => {
    expect(copyLengthProblem(original, copy({ channels: 2 }))).toMatch(/channels 1 became 2/);
    expect(copyLengthProblem(original, copy({ preSkip: 0 }))).toMatch(/pre-skip/);
  });

  it("scales the expected length to the original's sample rate", () => {
    const at441: FlacFacts = { sampleRate: 44_100, channels: 1, bitsPerSample: 16, totalSamples: 441_000 };
    expect(copyLengthProblem(at441, copy({ samples: 480_000 }))).toBeNull();
    expect(copyLengthProblem(at441, copy({ samples: 441_000 }))).toMatch(/length/);
  });

  it("does not guess when the FLAC never said how long it is", () => {
    expect(copyLengthProblem({ ...original, totalSamples: 0 }, copy({ samples: 1 }))).toBeNull();
  });

  it("reads STREAMINFO: rate, channels, bits and the 36-bit sample count", () => {
    const head = Buffer.alloc(42);
    head.write("fLaC", 0, "latin1");
    head[4] = 0; // STREAMINFO, not the last block
    head.writeUIntBE(34, 5, 3);
    // 44100 Hz (20 bits), 2 channels (3 bits: 1), 24 bits (5 bits: 23), 5_000_000_000 samples (36 bits).
    const samples = 5_000_000_000n;
    const word = (44_100n << 44n) | (1n << 41n) | (23n << 36n) | samples;
    head.writeBigUInt64BE(word, 8 + 10);
    expect(readFlacStreamInfo(head)).toEqual({
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 24,
      totalSamples: 5_000_000_000,
    });
    expect(readFlacStreamInfo(Buffer.from("OggS not a flac header, long enough to read 42 bytes"))).toBeNull();
    expect(readFlacStreamInfo(Buffer.alloc(10))).toBeNull();
  });

  it("the command line carries the guards and nothing that moves a sample", () => {
    const args = listenCopyArgs("/in", "/out", { channels: 1, maxSeconds: 200 });
    const text = args.join(" ");
    expect(text).toContain("-protocol_whitelist file");
    expect(text).toContain("-f flac");
    expect(text).toContain("-c:a libopus");
    expect(text).toContain(`-b:a ${LISTEN_COPY_BITRATE_PER_CHANNEL}`);
    expect(text).toContain("-map_metadata -1");
    expect(text).toContain("-t 200");
    expect(text).toContain("-fs ");
    for (const forbidden of ["-ss", "apad", "-shortest", "atrim", "adelay", "-itsoffset"]) {
      expect(args.some((arg) => arg.includes(forbidden)), forbidden).toBe(false);
    }
    // Stereo gets twice the rate, so each channel keeps what a mono stem has.
    expect(listenCopyArgs("/in", "/out", { channels: 2, maxSeconds: 1 }).join(" ")).toContain(
      `-b:a ${LISTEN_COPY_BITRATE_PER_CHANNEL * 2}`,
    );
  });

  it("bounds a pass by the recorder's stated length plus slack", () => {
    expect(maxCopySeconds(180_000)).toBe(210);
    expect(maxCopySeconds(1)).toBe(31);
  });
});

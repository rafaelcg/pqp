import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crc16, crc8, encodeFlac } from "./flac";
import { quantize } from "./pcm";

/**
 * A minimal FLAC decoder for exactly the subset `flac.ts` writes, so the
 * round trip is checked in CI without a browser. It is written from the RFC,
 * not from the encoder, and checks both CRCs; the ffmpeg test below is the
 * independent decoder (skipped when ffmpeg is not installed).
 */
function decodeFlac(bytes: Uint8Array): { sampleRate: number; channels: Int32Array[]; bps: number } {
  let pos = 0;
  let bit = 0;
  const read = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = v * 2 + ((bytes[pos] >> (7 - bit)) & 1);
      if (++bit === 8) {
        bit = 0;
        pos++;
      }
    }
    return v;
  };
  const signed = (n: number) => {
    const v = read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  };
  const unary = () => {
    let q = 0;
    while (read(1) === 0) q++;
    return q;
  };
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("fLaC");
  pos = 4;
  let sampleRate = 0;
  let nch = 0;
  let bps = 0;
  let total = 0;
  for (;;) {
    const last = read(1);
    const type = read(7);
    const len = read(24);
    if (type === 0) {
      read(16);
      read(16);
      read(24);
      read(24);
      sampleRate = read(20);
      nch = read(3) + 1;
      bps = read(5) + 1;
      total = read(36);
      pos += 16;
    } else {
      pos += len;
    }
    if (last) break;
  }
  const out = Array.from({ length: nch }, () => new Int32Array(total));
  let written = 0;
  while (written < total) {
    const frameStart = pos;
    expect(read(14)).toBe(0b11111111111110);
    read(2);
    const bsCode = read(4);
    read(4);
    read(4);
    read(3);
    read(1);
    // frame number (utf-8 style)
    const first = read(8);
    let extra = 0;
    for (let m = 0x80; first & m; m >>= 1) extra++;
    for (let i = 1; i < extra; i++) read(8);
    let n: number;
    if (bsCode === 0b1100) n = 4096;
    else if (bsCode === 0b0110) n = read(8) + 1;
    else if (bsCode === 0b0111) n = read(16) + 1;
    else throw new Error(`blocksize code ${bsCode}`);
    const hcrc = crc8(bytes, frameStart, pos);
    expect(read(8)).toBe(hcrc);
    for (let c = 0; c < nch; c++) {
      read(1);
      const type = read(6);
      read(1);
      const dst = out[c];
      if (type === 0) {
        const v = signed(bps);
        for (let i = 0; i < n; i++) dst[written + i] = v;
      } else if (type === 1) {
        for (let i = 0; i < n; i++) dst[written + i] = signed(bps);
      } else if ((type & 0b111000) === 0b001000) {
        const order = type & 7;
        const x = new Int32Array(n);
        for (let i = 0; i < order; i++) x[i] = signed(bps);
        const method = read(2);
        const po = read(4);
        const parts = 1 << po;
        const res: number[] = [];
        for (let p = 0; p < parts; p++) {
          const k = read(method ? 5 : 4);
          const count = (n >> po) - (p === 0 ? order : 0);
          for (let i = 0; i < count; i++) {
            const u = unary() * 2 ** k + read(k);
            res.push(u % 2 === 0 ? u / 2 : -(u + 1) / 2);
          }
        }
        for (let i = order; i < n; i++) {
          const r = res[i - order];
          const p =
            order === 0
              ? 0
              : order === 1
                ? x[i - 1]
                : order === 2
                  ? 2 * x[i - 1] - x[i - 2]
                  : order === 3
                    ? 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]
                    : 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
          x[i] = p + r;
        }
        dst.set(x, written);
      } else {
        throw new Error(`subframe type ${type}`);
      }
    }
    if (bit) {
      bit = 0;
      pos++;
    }
    const fcrc = crc16(bytes, frameStart, pos);
    expect(read(16)).toBe(fcrc);
    written += n;
  }
  return { sampleRate, channels: out, bps };
}

/** Something with the statistics of a plucked string: Karplus-Strong plus room hiss and silence. */
function pluckedTake(sampleRate: number, seconds: number, seed = 1): Float32Array {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  const notes = [82.4, 110, 146.8, 196, 246.9, 329.6];
  let t = Math.round(sampleRate * 0.5);
  while (t < n - sampleRate) {
    const f = notes[Math.floor((rand() + 0.5) * notes.length) % notes.length];
    const period = Math.round(sampleRate / f);
    const ring = new Float32Array(period);
    for (let i = 0; i < period; i++) ring[i] = rand() * 0.8;
    const len = Math.round(sampleRate * (0.4 + (rand() + 0.5) * 0.8));
    for (let i = 0; i < len && t + i < n; i++) {
      const j = i % period;
      const next = ring[(j + 1) % period];
      ring[j] = 0.996 * 0.5 * (ring[j] + next);
      out[t + i] += ring[j];
    }
    t += Math.round(len * 0.8);
  }
  for (let i = 0; i < n; i++) out[i] += rand() * 0.0006;
  return out;
}

describe("flac encoder", () => {
  it("round trips 16-bit mono bit for bit, through every subframe kind", () => {
    const sr = 48000;
    const music = pluckedTake(sr, 3);
    // a stretch of digital silence (CONSTANT) and of full-scale noise (VERBATIM)
    const signal = new Float32Array(music.length + 9000 + 5000);
    signal.set(music, 0);
    let s = 7;
    for (let i = 0; i < 5000; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      signal[music.length + 9000 + i] = (s / 2 ** 32) * 2 - 1;
    }
    const bytes = encodeFlac([signal], sr);
    const dec = decodeFlac(bytes);
    expect(dec.sampleRate).toBe(sr);
    expect(dec.bps).toBe(16);
    expect(Array.from(dec.channels[0])).toEqual(Array.from(quantize(signal, 16)));
  });

  it("round trips stereo, 24-bit, odd lengths and a 44.1 kHz rate", () => {
    const sr = 44100;
    const a = pluckedTake(sr, 1.3, 3);
    const b = pluckedTake(sr, 1.3, 9);
    const dec = decodeFlac(encodeFlac([a, b], sr, { bitsPerSample: 24 }));
    expect(dec.sampleRate).toBe(sr);
    expect(Array.from(dec.channels[0])).toEqual(Array.from(quantize(a, 24)));
    expect(Array.from(dec.channels[1])).toEqual(Array.from(quantize(b, 24)));
  });

  it("handles a take shorter than one block and a single sample", () => {
    for (const len of [1, 17, 300, 4097]) {
      const x = pluckedTake(48000, 1).subarray(20000, 20000 + len);
      const dec = decodeFlac(encodeFlac([Float32Array.from(x)], 48000));
      expect(Array.from(dec.channels[0])).toEqual(Array.from(quantize(Float32Array.from(x), 16)));
    }
  });

  it("is meaningfully smaller than WAV on plucked strings with gaps", () => {
    const sr = 48000;
    const x = pluckedTake(sr, 10);
    const bytes = encodeFlac([x], sr);
    const wav = x.length * 2;
    expect(bytes.length / wav).toBeLessThan(0.75);
  });

  let ffmpeg = false;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    ffmpeg = true;
  } catch {
    ffmpeg = false;
  }
  it.skipIf(!ffmpeg)("decodes bit-exact in ffmpeg, an independent decoder", () => {
    const sr = 48000;
    const x = pluckedTake(sr, 4, 5);
    const dir = mkdtempSync(path.join(os.tmpdir(), "pqp-flac-"));
    const flac = path.join(dir, "x.flac");
    const raw = path.join(dir, "x.raw");
    writeFileSync(flac, encodeFlac([x], sr));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", flac, "-f", "s16le", raw]);
    const buf = readFileSync(raw);
    const got = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    expect(got.length).toBe(x.length);
    expect(Array.from(got)).toEqual(Array.from(quantize(x, 16)));
  });
});

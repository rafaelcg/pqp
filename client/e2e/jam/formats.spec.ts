/**
 * WHICH UPLOAD FORMAT: measured, per browser, not assumed.
 *
 * A known signal (a down-sweep every second, at exactly known samples) is
 * encoded with ffmpeg into each candidate (and with our own FLAC encoder),
 * then decoded by each browser's `decodeAudioData` on a 48 kHz context. For
 * each file we report how far the sweeps moved (median, in samples and ms),
 * the length change, and for lossless files whether the samples came back
 * exact.
 *
 * Lossy codecs add priming samples at the start (Opus pre-skip 312, AAC
 * 1024 or 2112, MP3 ~1105) and padding at the end; whether a browser trims
 * them on decode is exactly the question. The constraint is <= 1 ms of
 * movement through a round trip.
 *
 * Also measured in Node (once): bytes for one minute of synthetic plucked
 * strings, per format, to quote a five-minute size.
 *
 * Needs ffmpeg with libopus and libmp3lame; skips without it. Run:
 *   pnpm --filter @pqp/client exec playwright test -c playwright.jam.config.ts formats.spec.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { encodeFlac } from "../../src/lib/jam/flac";
import { encodeWav } from "../../src/lib/jam/pcm";
import { pulseTrain, sweep } from "../../src/lib/jam/signals";

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const DIR = path.join(os.tmpdir(), "pqp-jam-formats");
const PULSES_AT_SEC = [1, 2, 3, 4, 5, 6, 7, 8];
const SECONDS = 10;

interface Candidate {
  name: string;
  file: string;
  sourceRate: number;
  lossless: boolean;
}

function makeFiles(): Candidate[] {
  mkdirSync(DIR, { recursive: true });
  const out: Candidate[] = [];
  for (const sr of [48000, 44100]) {
    const x = pulseTrain(
      SECONDS * sr,
      sweep(sr, { direction: "down", amplitude: 0.5 }),
      PULSES_AT_SEC.map((s) => Math.round(s * sr)),
    );
    const wav = path.join(DIR, `src-${sr}.wav`);
    writeFileSync(wav, encodeWav([x], sr));
    const ours = path.join(DIR, `ours-${sr}.flac`);
    writeFileSync(ours, encodeFlac([x], sr));
    out.push({ name: `wav ${sr}`, file: wav, sourceRate: sr, lossless: true });
    out.push({ name: `flac (ours) ${sr}`, file: ours, sourceRate: sr, lossless: true });
    const ff = (name: string, ext: string, args: string[], lossless = false) => {
      const file = path.join(DIR, `${name.replace(/[^a-z0-9]+/gi, "-")}-${sr}.${ext}`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, ...args, file]);
      out.push({ name: `${name} ${sr}`, file, sourceRate: sr, lossless });
    };
    ff("flac (ffmpeg)", "flac", ["-c:a", "flac"], true);
    if (sr === 48000) {
      ff("opus/ogg 128k", "ogg", ["-c:a", "libopus", "-b:a", "128k"]);
      ff("opus/webm 128k", "webm", ["-c:a", "libopus", "-b:a", "128k"]);
    }
    ff("aac/m4a 192k", "m4a", ["-c:a", "aac", "-b:a", "192k"]);
    ff("mp3 192k", "mp3", ["-c:a", "libmp3lame", "-b:a", "192k"]);
  }
  return out;
}

test.describe("upload format round trip", () => {
  test.skip(!hasFfmpeg(), "needs ffmpeg");

  let files: Candidate[] = [];
  test.beforeAll(() => {
    files = makeFiles();
  });

  test("decodeAudioData moves lossless files by 0 samples; lossy ones by a codec- and browser-dependent amount", async ({
    page,
    browserName,
  }) => {
    await page.goto("/e2e/jam/harness.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    const rows: unknown[] = [];
    for (const f of files) {
      const b64 = readFileSync(f.file).toString("base64");
      const row = await page.evaluate(
        async ({ b64, f, pulsesAt, seconds }) => {
          const { fromBase64, sweep, findPulse } = window.jamTest;
          const sr = 48000;
          const ctx = new OfflineAudioContext(1, 1, sr);
          let decoded: AudioBuffer;
          try {
            decoded = await ctx.decodeAudioData(fromBase64(b64));
          } catch (e) {
            return { name: f.name, error: String(e) };
          }
          const x = decoded.getChannelData(0);
          const ref = sweep(sr, { direction: "down", amplitude: 0.5 });
          const shifts: number[] = [];
          for (const s of pulsesAt) {
            const at = Math.round(s * sr);
            const m = findPulse(x, ref, at - 4000, at + 4000, { sampleRate: sr });
            if (m) shifts.push(m.position - at);
          }
          shifts.sort((a, b) => a - b);
          const med = shifts[shifts.length >> 1];
          // lossless check: decoded * 32768 should be integers equal to the source
          let offGrid = 0;
          let maxPos = 0;
          for (let i = 0; i < x.length; i++) {
            const v = x[i] * 32768;
            offGrid = Math.max(offGrid, Math.abs(v - Math.round(v)));
            if (x[i] > maxPos) maxPos = x[i];
          }
          return {
            name: f.name,
            decodedRate: decoded.sampleRate,
            lengthDelta: decoded.length - seconds * sr,
            shiftSamples: Math.round(med * 100) / 100,
            shiftMs: Math.round((med / sr) * 1000 * 1000) / 1000,
            spreadSamples: Math.round((shifts[shifts.length - 1] - shifts[0]) * 100) / 100,
            offGridLsb: Math.round(offGrid * 1000) / 1000,
            maxPositive: maxPos,
          };
        },
        { b64, f, pulsesAt: PULSES_AT_SEC, seconds: SECONDS },
      );
      rows.push(row);
    }
    // eslint-disable-next-line no-console -- the measured numbers are the output
    console.log(`[formats] ${browserName}\n${JSON.stringify(rows, null, 1)}`);
    const ours = rows.find((r) => (r as { name: string }).name === "flac (ours) 48000") as {
      shiftSamples: number;
      lengthDelta: number;
      error?: string;
    };
    expect(ours.error).toBeUndefined();
    expect(Math.abs(ours.shiftSamples)).toBeLessThan(0.05);
    expect(ours.lengthDelta).toBe(0);
  });

  test("bytes per minute of plucked strings, per format (Node, once)", async ({ browserName }) => {
    test.skip(browserName !== "chromium", "measured once");
    const sr = 48000;
    // a minute of Karplus-Strong plucks with gaps and a little hiss
    let s = 1;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32 - 0.5;
    };
    const n = sr * 60;
    const x = new Float32Array(n);
    let t = sr / 2;
    const notes = [41.2, 55, 73.4, 82.4, 98, 110, 146.8];
    while (t < n - sr) {
      const f = notes[Math.floor((rand() + 0.5) * notes.length) % notes.length];
      const period = Math.round(sr / f);
      const ring = Float32Array.from({ length: period }, () => rand() * 0.9);
      const len = Math.round(sr * (0.3 + (rand() + 0.5) * 0.6));
      for (let i = 0; i < len && t + i < n; i++) {
        const j = i % period;
        ring[j] = 0.997 * 0.5 * (ring[j] + ring[(j + 1) % period]);
        x[t + i] += ring[j];
      }
      t += Math.round(len * (rand() > 0.3 ? 0.9 : 1.6));
    }
    for (let i = 0; i < n; i++) x[i] += rand() * 0.0008;
    const wav = path.join(DIR, "minute.wav");
    writeFileSync(wav, encodeWav([x], sr));
    const t0 = Date.now();
    const oursBytes = encodeFlac([x], sr).length;
    const oursMs = Date.now() - t0;
    const size = (args: string[], ext: string) => {
      const f = path.join(DIR, `minute-${ext}`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, ...args, f]);
      return statSync(f).size;
    };
    const table = {
      wav16: statSync(wav).size,
      flacOurs: oursBytes,
      flacOursEncodeMsPerMinute: oursMs,
      flacFfmpegLevel5: size(["-c:a", "flac", "-compression_level", "5"], "5.flac"),
      flacFfmpegLevel8: size(["-c:a", "flac", "-compression_level", "8"], "8.flac"),
      opus128: size(["-c:a", "libopus", "-b:a", "128k"], "o.ogg"),
      aac192: size(["-c:a", "aac", "-b:a", "192k"], "a.m4a"),
    };
    // eslint-disable-next-line no-console -- the measured numbers are the output
    console.log(`[formats] bytes per minute (synthetic plucks, mono 48 kHz)\n${JSON.stringify(table, null, 1)}`);
    expect(table.flacOurs).toBeLessThan(table.wav16);
  });
});

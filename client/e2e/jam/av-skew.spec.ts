/**
 * HOW FAR APART THE PICTURE AND THE SOUND ARE INSIDE A RECORDED CAMERA FILE,
 * per container: the measurement behind `VIDEO_MIME_PREFERENCE` (WebM first).
 *
 * The engine finds the video's time zero by locating the file's DECODED audio
 * in the take (`alignVideoAudio`), which is right only if the file's decoded
 * audio and its picture agree on what time zero is. This spec records the
 * same synthetic scene as WebM (VP8 + Opus) and as MP4 (H.264 + AAC), several
 * times each, alternating: a canvas that flashes white and a click, both
 * scheduled for the same AudioContext instant. ffmpeg then decodes each file
 * and the spec reports `audio onset - flash` per format.
 *
 * What it found (Chromium 151, macOS, 2026-11-12, two runs): WebM about -14
 * and -9 ms, MP4 about +27 and +19 ms, so the MP4's sound sits 28 to 41 ms
 * later against its picture, which is AAC's encoder priming (44 ms on this
 * platform's encoder): Chrome's fragmented MP4 has no edit list to account
 * for it, and `decodeAudioData` does not skip it either. Aligned by content
 * that file, the picture would lead the sound by about a frame,
 * and the engine's own zero check cannot see it (it measures the file against
 * itself). Hence Chromium records WebM, and the worker makes the MP4 phones
 * play with the time zero carried over exactly (`speech/video-transcode.test.ts`).
 *
 * The rig's own error is the canvas: it is painted from a timer and captured
 * at 30 fps, so a single flash is good to about a frame. Averaging eight
 * flashes over several takes is what makes the difference visible; the absolute
 * numbers are offsets of the rig (the painting is late by about half a frame),
 * only the DIFFERENCE between the formats means anything.
 *
 * Needs ffmpeg (formats.spec.ts does too) and skips without it. The MP4 half
 * skips where the browser cannot record H.264 + AAC.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const haveFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0;

const MP4 = "video/mp4;codecs=avc1.42E01E,mp4a.40.2";
const WEBM = "video/webm;codecs=vp8,opus";

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "fake capture devices and this recorder are Chromium's");
  test.skip(!haveFfmpeg, "needs ffmpeg to read the files back");
  await page.goto("/e2e/jam/harness.html");
  await expect(page.locator("#ready")).toHaveText("ready");
});

interface Recorded {
  type: string;
  b64: string;
}

/** Record the flash-and-click scene `trials` times per type, alternating the order. */
async function record(page: import("@playwright/test").Page, types: string[], trials: number): Promise<Recorded[]> {
  return page.evaluate(
    async ({ types, trials }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const keep = ctx.createConstantSource();
      keep.offset.value = 0;
      keep.connect(dest);
      keep.start();
      const click = ctx.createBuffer(1, 144, 48000);
      const data = click.getChannelData(0);
      for (let i = 0; i < 144; i++) data[i] = 0.8 * Math.sin((2 * Math.PI * 3000 * i) / 48000) * Math.exp(-i / 60);
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      document.body.appendChild(canvas);
      const g = canvas.getContext("2d")!;
      let flashes: number[] = [];
      // A timer, not requestAnimationFrame: a headless page may not run rAF.
      setInterval(() => {
        const now = ctx.currentTime;
        g.fillStyle = flashes.some((t) => now >= t && now < t + 0.15) ? "#fff" : "#000";
        g.fillRect(0, 0, 640, 360);
      }, 16);
      const video = canvas.captureStream(30).getVideoTracks()[0]!;
      const audio = dest.stream.getAudioTracks()[0]!;
      const out: { type: string; b64: string }[] = [];
      for (let t = 0; t < trials; t++) {
        for (const type of t % 2 === 0 ? types : types.slice().reverse()) {
          // No bitrate options: Chromium's MP4 recorder refuses an audio bitrate here.
          const rec = new MediaRecorder(new MediaStream([video, audio]), { mimeType: type });
          const chunks: Blob[] = [];
          rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          await new Promise<void>((res) => {
            rec.onstart = () => res();
            rec.start(1000);
          });
          const t0 = ctx.currentTime + 0.6;
          flashes = [];
          for (let k = 0; k < 8; k++) {
            const at = t0 + k * 0.5;
            flashes.push(at);
            const src = ctx.createBufferSource();
            src.buffer = click;
            src.connect(dest);
            src.start(at);
          }
          await sleep(5000);
          const blob = await new Promise<Blob>((res) => {
            rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType }));
            rec.stop();
          });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let s = "";
          for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
          out.push({ type, b64: btoa(s) });
        }
      }
      return out;
    },
    { types, trials },
  );
}

/** Mean of (click onset - flash onset), milliseconds, over the clicks of one file. */
function skewMs(file: string): number {
  const raw = execFileSync(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], {
    maxBuffer: 1 << 28,
  });
  const x = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const clicks: number[] = [];
  let last = -1e9;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]!) > 0.1) {
      if (i - last > 48000 * 0.3) clicks.push(i / 48000);
      last = i;
    }
  }
  const info = spawnSync(FFMPEG, ["-hide_banner", "-i", file, "-an", "-vf", "scale=2:2,format=gray,showinfo", "-f", "null", "-"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  }).stderr;
  const flashes: number[] = [];
  let was = false;
  for (const line of info.split("\n")) {
    const m = /pts_time:([\d.]+).*mean:\[(\d+)/.exec(line);
    if (!m) continue;
    const on = Number(m[2]) > 128;
    if (on && !was) flashes.push(Number(m[1]));
    was = on;
  }
  const n = Math.min(clicks.length, flashes.length);
  expect(n, `clicks ${clicks.length}, flashes ${flashes.length} in ${path.basename(file)}`).toBeGreaterThanOrEqual(6);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (clicks[i]! - flashes[i]!) * 1000;
  return sum / n;
}

test("the picture and the sound agree inside a WebM, and the MP4 is measured against it", async ({ page }) => {
  const mp4Supported = await page.evaluate((t) => MediaRecorder.isTypeSupported(t), MP4);
  const types = mp4Supported ? [MP4, WEBM] : [WEBM];
  const recorded = await record(page, types, 2);
  const dir = mkdtempSync(path.join(tmpdir(), "pqp-jam-skew-"));
  try {
    const skews: Record<string, number[]> = { mp4: [], webm: [] };
    recorded.forEach((r, i) => {
      const kind = r.type.includes("mp4") ? "mp4" : "webm";
      const file = path.join(dir, `take-${i}.${kind}`);
      writeFileSync(file, Buffer.from(r.b64, "base64"));
      skews[kind]!.push(skewMs(file));
    });
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const webm = mean(skews.webm!);
    // eslint-disable-next-line no-console -- the measured numbers are the output
    console.log("[jam] A/V skew (audio onset - flash, ms)", JSON.stringify({ webm: skews.webm, mp4: skews.mp4 }));
    // The rig: a flash painted from a timer and captured at 30 fps is late by
    // about half a frame, never by a whole one.
    expect(Math.abs(webm)).toBeLessThan(50);
    if (mp4Supported) {
      expect(skews.mp4!.length).toBe(skews.webm!.length);
      const delta = mean(skews.mp4!) - webm;
      // eslint-disable-next-line no-console -- the measured numbers are the output
      console.log(`[jam] MP4 sound is ${delta.toFixed(1)} ms later than WebM's against the picture (AAC priming; 28 to 41 on macOS)`);
      test.info().annotations.push({ type: "mp4-minus-webm-ms", description: delta.toFixed(1) });
    } else {
      test.info().annotations.push({ type: "mp4", description: "not recordable in this Chromium" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

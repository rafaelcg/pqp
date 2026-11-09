/**
 * THE JAM ENGINE'S CLAIM, END TO END IN A REAL BROWSER: a take recorded over
 * a backing lands on the backing, through the real AudioContext, the real
 * capture worklet, FLAC, `decodeAudioData` and real-time playback.
 *
 * THE SETUP, AND WHAT IT CANNOT PROVE. Chromium runs with a fake microphone
 * (`--use-file-for-fake-audio-capture`) playing a down-sweep once a second,
 * forever (`playwright.jam.config.ts`). That file is the "musician": it
 * plays a steady beat. A fake device has NO hardware latency and cannot hear
 * the speakers, so there is no real loopback here. What happens instead:
 *
 *   1. The loopback calibration plays its sweeps once a second and finds the
 *      fake mic's sweeps in the capture. The lag it reports is just the
 *      phase between the two beats, an arbitrary number in 0..970 ms, but it
 *      is measured by the exact code and clock a real calibration uses.
 *   2. The take is started on the calibration's grid (`captureStartFrame`),
 *      so the musician's beat stands in the same relation to the backing as
 *      it did to the calibration clicks: exactly like a real player who
 *      plays a fixed latency after what they hear.
 *   3. If every stage (worklet frame stamps, chunk assembly, calibration
 *      arithmetic, placement, whole-ms rounding, FLAC, decode, scheduling) is
 *      right, every one of the musician's sweeps lands on a backing beat. An
 *      error anywhere of up to +-500 ms shows up as a miss.
 *
 * Real-world latency (DAC, ADC, drivers, Bluetooth, the acoustic path) is not
 * exercised. That checklist is in docs/JAM_ENGINE.md for a person with a
 * guitar.
 *
 * TOLERANCE: 0.05 ms (2.4 samples at 48 kHz) for placement, 1.5 samples for the
 * take against the backing in real-time playback, 1 sample for the playback
 * schedule itself. Measured: 1 sample, 1.1 samples and 0.1 sample. The
 * numbers are logged and quoted in docs/JAM_ENGINE.md.
 */
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "fake capture devices are a Chromium feature");
  page.on("console", (m) => {
    if (m.type() === "error") console.warn("[page]", m.text());
  });
  await page.goto("/e2e/jam/harness.html");
  await expect(page.locator("#ready")).toHaveText("ready");
});

interface RunResult {
  sampleRate: number;
  calibration: { roundTripMs: number; confidence: string; spreadMs: number; accepted: number };
  offsetMs: number;
  placementErrorsMs: number[];
  hits: number;
  /** Worst decoded-vs-encoded difference, in 16-bit LSBs. */
  flacMaxDiff: number;
  flacBytes: number;
  wavBytes: number;
  playbackPairsSamples: number[];
  playbackScheduleErrorsSamples: number[];
  video: null | {
    mimeType: string;
    method: string;
    quality: number;
    zeroCheckMs: number | null;
    /** How far MediaRecorder's start event was from the measured time zero, ms. */
    timestampGuessErrorMs: number;
    bytes: number;
  };
}

async function runTake(page: import("@playwright/test").Page, withCamera: boolean): Promise<RunResult> {
  return page.evaluate(async (withCamera) => {
    const { jam, pulseTrain, sweep, findAll, locate, tap } = window.jamTest;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const engine = await jam.JamEngine.create();
    const ctx = engine.context;
    const sr = ctx.sampleRate;
    const up = sweep(sr, { direction: "up" });
    const down = sweep(sr, { direction: "down" });

    // backing: an up-sweep on every beat at 120 BPM
    const beat = Math.round(0.5 * sr);
    const backing = pulseTrain(30 * sr, up, Array.from({ length: 60 }, (_, k) => k * beat));
    const buf = ctx.createBuffer(1, backing.length, sr);
    buf.copyToChannel(backing, 0);
    engine.player.addStem({ id: "backing", buffer: buf });

    await engine.openInput();

    // 1. calibrate (retry if the fake beat fell in the 30 ms blind spot)
    let emitted: number[] = [];
    let cal = await engine.calibrate("loopback", {
      periodMs: 1000,
      maxLatencyMs: 970,
      pulses: 6,
      onCapture: (c) => (emitted = c.emitted),
    });
    for (let i = 0; i < 2 && cal.confidence === "failed"; i++) {
      await sleep(333);
      cal = await engine.calibrate("loopback", {
        periodMs: 1000,
        maxLatencyMs: 970,
        pulses: 6,
        onCapture: (c) => (emitted = c.emitted),
      });
    }

    // 2. record on the calibration's grid, count-in of one bar (2 s = 2 beats of the musician)
    const countIn = { bars: 1 as const, beatsPerBar: 4, bpm: 120 };
    const countFrames = 4 * beat;
    const earliest = Math.round(ctx.currentTime * sr) + Math.round(0.3 * sr);
    let f0 = emitted[0];
    while (f0 - countFrames < earliest) f0 += sr; // one musician period is exactly sr frames
    let camera: MediaStream | null = null;
    if (withCamera) camera = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } });
    // with a camera the recorder starts MediaRecorder first and awaits it; leave room
    if (withCamera) f0 += 2 * sr;
    const fromMs = 2000;
    const rec = await engine.record({ fromMs, countIn, latency: cal, camera, captureStartFrame: f0 - countFrames });
    const until = (f0 + 5.2 * sr) / sr;
    while (ctx.currentTime < until) await sleep(100);
    const take = await rec.stop();
    camera?.getTracks().forEach((t) => t.stop());

    // 3. the upload round trip
    const upload = await jam.prepareStemUpload(take);
    const decoded = await engine.player.decode(upload.audio);
    const x = decoded.getChannelData(0);
    // Lossless means the decoded integers are the encoded integers. How a
    // browser maps int16 to float differs (Chrome divides positives by 32767
    // and negatives by 32768; Firefox and WebKit divide both by 32768), so
    // compare in LSBs under whichever mapping the browser used.
    let flacMaxDiff = 0;
    for (let i = 0; i < take.samples.length; i++) {
      const q = Math.max(-32768, Math.min(32767, Math.round(take.samples[i] * 32768)));
      const lsb = Math.min(Math.abs(x[i] * 32768 - q), Math.abs(x[i] * (x[i] > 0 ? 32767 : 32768) - q));
      flacMaxDiff = Math.max(flacMaxDiff, lsb);
    }

    // 4. where the musician's sweeps sit on the song: on a beat, i.e. fromMs + k * 1000
    const hits = findAll(x, down, sr, 0.5);
    const placementErrorsMs = hits.map((h) => {
      const t = upload.offsetMs + (h.position / sr) * 1000;
      const k = Math.round((t - fromMs) / 1000);
      return Math.round((t - (fromMs + k * 1000)) * 10000) / 10000;
    });

    // 5. real-time playback of backing + take, tapped off the master bus
    engine.addTake("take", take);
    const t = await tap(ctx, engine.player.master);
    const startFrame = Math.round((ctx.currentTime + 0.3) * sr);
    t.start(startFrame - 256);
    engine.player.startAt(fromMs, startFrame / sr, null);
    while (ctx.currentTime < (startFrame + 4.6 * sr) / sr) await sleep(100);
    engine.player.pause();
    const out = (await t.stop())!;
    const y = out.channels[0];
    const ups = findAll(y, up, sr, 0.4);
    const downs = findAll(y, down, sr, 0.4);
    const playbackPairsSamples = downs.map((d) => {
      const nearest = ups.reduce((b, u) => (Math.abs(u.position - d.position) < Math.abs(b.position - d.position) ? u : b));
      return Math.round((d.position - nearest.position) * 1000) / 1000;
    });
    // backing beat k (song fromMs + k*500) should leave the graph at startFrame + k*beat
    const playbackScheduleErrorsSamples = ups.map((u) => {
      const rel = u.position - (startFrame - out.startFrame);
      const k = Math.round(rel / beat);
      return Math.round((rel - k * beat) * 1000) / 1000;
    });

    // 6. video: the file's own audio, found in the final take, should sit at sample 0
    let video: RunResult["video"] = null;
    if (take.video) {
      let zeroCheckMs: number | null = null;
      try {
        const fileAudio = (await ctx.decodeAudioData(await take.video.blob.arrayBuffer())).getChannelData(0);
        // The take is padded with silence back to the camera's first frame (the
        // camera starts before the capture), so look 5 s in, where both have the
        // musician. The fake mic repeats every second: search only +-300 ms.
        const at = Math.round(5 * sr);
        const pad = Math.round(0.3 * sr);
        const excerpt = fileAudio.subarray(at, at + 2 * sr);
        const m = locate(take.samples.subarray(at - pad, at + 2 * sr + pad), excerpt);
        if (m) zeroCheckMs = ((m.position - pad) / sr) * 1000;
        else console.error("zero check: no match", fileAudio.length, take.samples.length, excerpt.length);
      } catch (e) {
        console.error("zero check failed", String(e));
        zeroCheckMs = null;
      }
      video = {
        mimeType: take.video.mimeType,
        method: take.video.alignment.method,
        quality: Math.round(take.video.alignment.quality * 1000) / 1000,
        zeroCheckMs,
        timestampGuessErrorMs:
          ((take.video.alignment.timestampGuess - take.video.alignment.zeroFrame) / sr) * 1000,
        bytes: take.video.blob.size,
      };
    }
    await engine.destroy();
    return {
      sampleRate: sr,
      calibration: { roundTripMs: cal.roundTripMs, confidence: cal.confidence, spreadMs: cal.spreadMs, accepted: cal.accepted },
      offsetMs: upload.offsetMs,
      placementErrorsMs,
      hits: hits.length,
      flacMaxDiff,
      flacBytes: upload.audio.size,
      wavBytes: take.samples.length * 2 + 44,
      playbackPairsSamples,
      playbackScheduleErrorsSamples,
      video,
    };
  }, withCamera);
}

test("a take recorded over the backing lands on the backing, and plays back on it", async ({ page }) => {
  const r = await runTake(page, false);
  // eslint-disable-next-line no-console -- the measured numbers are the output
  console.log("[jam] audio-only", JSON.stringify(r, null, 1));
  expect(r.calibration.confidence).toBe("high");
  expect(Number.isInteger(r.offsetMs)).toBe(true);
  // the musician played ~9 beats (2 in the count-in, ~5 over the backing, plus the pre-roll)
  expect(r.hits).toBeGreaterThanOrEqual(6);
  for (const e of r.placementErrorsMs) expect(Math.abs(e)).toBeLessThan(0.05);
  expect(r.flacMaxDiff).toBeLessThan(0.001); // in LSBs: the integers came back exactly
  expect(r.flacMaxDiff).toBeGreaterThanOrEqual(0);
  expect(r.playbackPairsSamples.length).toBeGreaterThanOrEqual(3);
  // take vs backing at the speaker: the calibration's sub-sample peak estimate plus the
  // whole-millisecond rounding of the offset (<= 0.5 sample); measured 1.1 samples (23 us)
  for (const d of r.playbackPairsSamples) expect(Math.abs(d)).toBeLessThanOrEqual(1.5);
  for (const d of r.playbackScheduleErrorsSamples) expect(Math.abs(d)).toBeLessThanOrEqual(1);
});

test("with a camera: the take still lands, and the video's time zero is the take's sample 0", async ({ page }) => {
  const r = await runTake(page, true);
  // eslint-disable-next-line no-console -- the measured numbers are the output
  console.log("[jam] with camera", JSON.stringify(r, null, 1));
  expect(r.calibration.confidence).toBe("high");
  for (const e of r.placementErrorsMs) expect(Math.abs(e)).toBeLessThan(0.05);
  expect(r.video).not.toBeNull();
  expect(r.video!.bytes).toBeGreaterThan(10_000);
  expect(r.video!.method).toBe("content");
  // the file's audio is Opus/AAC with its own codec delay; a frame is 33 ms
  expect(r.video!.zeroCheckMs).not.toBeNull();
  expect(Math.abs(r.video!.zeroCheckMs!)).toBeLessThan(10);
});

test("a loop region repeats back to back: no gap and no doubled beat at the seam", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { jam, pulseTrain, sweep, findAll, tap } = window.jamTest;
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const engine = await jam.JamEngine.create();
    const ctx = engine.context;
    await ctx.resume();
    const sr = ctx.sampleRate;
    const up = sweep(sr, { direction: "up" });
    const beat = Math.round(0.5 * sr);
    const backing = pulseTrain(10 * sr, up, Array.from({ length: 20 }, (_, k) => k * beat));
    const buf = ctx.createBuffer(1, backing.length, sr);
    buf.copyToChannel(backing, 0);
    engine.player.addStem({ id: "backing", buffer: buf });
    engine.player.setLoop({ startMs: 1000, endMs: 2000 });
    const t = await tap(ctx, engine.player.master);
    const startFrame = Math.round((ctx.currentTime + 0.3) * sr);
    t.start(startFrame - 256);
    // song 500 -> 1000 -> 1500 -> (loop) 1000 -> 1500 -> 1000 ... for 4 s
    engine.player.startAt(500, startFrame / sr, engine.player.getLoop());
    while (ctx.currentTime < (startFrame + 4 * sr) / sr) await sleep(100);
    engine.player.pause();
    const out = (await t.stop())!;
    const hits = findAll(out.channels[0], up, sr, 0.4).map((h) => h.position - (startFrame - out.startFrame));
    await engine.destroy();
    return { beat, hits };
  });
  const intervals = r.hits.slice(1).map((h, i) => Math.round((h - r.hits[i]) * 100) / 100);
  // eslint-disable-next-line no-console -- the measured numbers are the output
  console.log("[jam] loop", JSON.stringify({ first: r.hits[0], intervals }));
  expect(r.hits.length).toBeGreaterThanOrEqual(7);
  expect(Math.abs(r.hits[0])).toBeLessThanOrEqual(1);
  for (const d of intervals) expect(Math.abs(d - r.beat)).toBeLessThanOrEqual(1);
});

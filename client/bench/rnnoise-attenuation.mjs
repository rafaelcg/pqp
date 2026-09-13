/**
 * How much does the advanced suppressor actually remove?
 *
 * A unit test can prove the node is wired in; it cannot prove it does
 * anything. This drives a real Chromium (the bundled Playwright one) because
 * an `AudioWorklet` cannot run in an `OfflineAudioContext` reliably and does
 * not exist at all in jsdom, so the only honest measurement is a real
 * `AudioContext` running in wall-clock time.
 *
 * It feeds two synthetic signals through the same graph, once with the RNNoise
 * worklet in it and once without, and reports the level in dBFS either way:
 *
 *   - white noise at -20 dBFS, which is "the room"; and
 *   - a 440 Hz tone plus that noise, which is a stand-in for a voice that the
 *     model has no reason to like (it is trained on speech, not sine waves),
 *     so the number under it is a floor and not a promise.
 *
 *   node bench/rnnoise-attenuation.mjs
 *
 * Not in CI: it needs a browser, it takes ~15 s, and an audio measurement on a
 * shared runner is a flake waiting to happen. Run it when the chain changes.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
// Resolve through an export the package actually declares: its `package.json`
// is not one of them, and `dist/index.js` is where everything else lives.
const distDir = path.dirname(
  require.resolve("@sapphi-red/web-noise-suppressor"),
);

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>rnnoise bench</title>
<script type="module">
import { loadRnnoise, RnnoiseWorkletNode } from "/dist/index.js";

const SAMPLE_RATE = 48000;
const SETTLE_MS = 700;
const MEASURE_MS = 2500;
/** -20 dBFS, as amplitude. */
const LEVEL = Math.pow(10, -20 / 20);

const dbfs = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -Infinity);

function noiseBuffer(ctx) {
  const buffer = ctx.createBuffer(1, SAMPLE_RATE * 4, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  // Uniform white noise scaled so its RMS is the level we asked for.
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * LEVEL * Math.sqrt(3);
  }
  return buffer;
}

async function run(ctx, binary, { tone, suppress }) {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  noise.loop = true;

  const mix = ctx.createGain();
  noise.connect(mix);

  let osc = null;
  if (tone) {
    osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const toneGain = ctx.createGain();
    // A sine's RMS is amplitude / sqrt(2); aim it at the same -20 dBFS.
    toneGain.gain.value = LEVEL * Math.SQRT2;
    osc.connect(toneGain).connect(mix);
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const sink = ctx.createMediaStreamDestination();

  let suppressor = null;
  if (suppress) {
    suppressor = new RnnoiseWorkletNode(ctx, {
      maxChannels: 1,
      wasmBinary: binary,
    });
    mix.connect(suppressor).connect(analyser);
  } else {
    mix.connect(analyser);
  }
  // Something has to pull the graph; an analyser on its own never runs.
  analyser.connect(sink);

  noise.start();
  osc?.start();
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const frame = new Float32Array(analyser.fftSize);
  let sum = 0;
  let count = 0;
  const until = performance.now() + MEASURE_MS;
  while (performance.now() < until) {
    analyser.getFloatTimeDomainData(frame);
    for (const sample of frame) {
      sum += sample * sample;
    }
    count += frame.length;
    await new Promise((r) => setTimeout(r, 25));
  }

  noise.stop();
  osc?.stop();
  suppressor?.destroy();
  analyser.disconnect();
  mix.disconnect();
  return dbfs(Math.sqrt(sum / count));
}

window.measure = async () => {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.resume();
  await ctx.audioWorklet.addModule("/dist/rnnoise/workletProcessor.js");
  const binary = await loadRnnoise({
    url: "/dist/rnnoise.wasm",
    simdUrl: "/dist/rnnoise_simd.wasm",
  });

  const out = {
    sampleRate: ctx.sampleRate,
    noiseBefore: await run(ctx, binary, { tone: false, suppress: false }),
    noiseAfter: await run(ctx, binary, { tone: false, suppress: true }),
    toneBefore: await run(ctx, binary, { tone: true, suppress: false }),
    toneAfter: await run(ctx, binary, { tone: true, suppress: true }),
  };
  await ctx.close();
  return out;
};
</script>`;

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (!url.startsWith("/dist/") || url.includes("..")) {
    res.writeHead(404).end();
    return;
  }
  try {
    const file = path.join(distDir, url.slice("/dist/".length));
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// The loopback server must never outlive this process, however it ends: a
// launch that throws before the `try` block below, Chromium crashing or
// being killed mid-measurement (which the `finally` never reaches, because
// `browser.close()` on an already-dead browser can itself hang), or the
// script being interrupted from the terminal. Every one of those leaves a
// listening socket bound to 127.0.0.1 with nothing left to stop it.
let closedServer = false;
function closeServerOnce() {
  if (closedServer) {
    return;
  }
  closedServer = true;
  server.close();
}
process.once("exit", closeServerOnce);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    closeServerOnce();
    process.exit(1);
  });
}

let browser;
try {
  browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  // Chromium can exit on its own (a crash, an OOM-kill in a constrained CI
  // container) without ever reaching the `finally` below.
  browser.on("disconnected", closeServerOnce);

  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[page]", m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof window.measure === "function");
  const r = await page.evaluate(() => window.measure());

  const fmt = (n) => `${n.toFixed(1)} dBFS`;
  console.log(`context sample rate: ${r.sampleRate} Hz`);
  console.log("");
  console.log("white noise only (-20 dBFS target)");
  console.log(`  before: ${fmt(r.noiseBefore)}`);
  console.log(`  after:  ${fmt(r.noiseAfter)}`);
  console.log(`  removed: ${(r.noiseBefore - r.noiseAfter).toFixed(1)} dB`);
  console.log("");
  console.log("440 Hz tone + white noise");
  console.log(`  before: ${fmt(r.toneBefore)}`);
  console.log(`  after:  ${fmt(r.toneAfter)}`);
  console.log(`  removed: ${(r.toneBefore - r.toneAfter).toFixed(1)} dB`);
} finally {
  await browser?.close();
  closeServerOnce();
}

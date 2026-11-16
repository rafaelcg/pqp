/**
 * The voice gate in a REAL browser, wired the way a Voz limpa microphone is.
 *
 * `voice-gate-bench.mjs` measures the same DSP in plain Node. What that cannot
 * prove is everything the browser adds: that the worklet file loads through
 * `audioWorklet.addModule` with its `export` statements, that a node with two
 * inputs and an explicit mono channel count really delivers RNNoise's audio on
 * input 0 and the raw microphone on input 1, that RNNoise's own delay is the
 * head start the sidechain assumes, and that the numbers come out the same.
 *
 * One pass of the fixture scene through three branches of one graph, each a
 * channel of the rendered result, so the three line up sample for sample:
 *
 *   scene -> RNNoise -------------------------------> channel 0  (the baseline)
 *   scene -> RNNoise -> gate (+ scene as sidechain) -> channel 1  (Voz limpa)
 *   scene -> gate, no sidechain, 8 ms lookahead -----> channel 2  (gate alone)
 *
 *   node bench/voice-gate-browser.mjs
 *
 * It renders with an OfflineAudioContext, because a headless Chromium on a
 * machine with no audio output (a CI box, an agent sandbox) reports a renderer
 * error on a realtime context and renders nothing. The RNNoise worklet starts
 * its wasm asynchronously and outputs silence until it is up, so the render is
 * suspended for a moment before the scene starts and the worklet thread gets
 * to finish. Not in CI. It exits non-zero when a branch is silent or the gate
 * clips a word, so it can be run as a smoke test before a release that touches
 * the chain.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildScene } from "../src/lib/voice-gate/fixtures.ts";
import * as M from "../src/lib/voice-gate/metrics.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const distDir = path.dirname(require.resolve("@sapphi-red/web-noise-suppressor"));
const gateFile = path.resolve(here, "../src/lib/voice-gate/voice-gate-worklet.js");
const SR = 48000;

const scene = buildScene();
const sceneBytes = Buffer.from(scene.mix.buffer, scene.mix.byteOffset, scene.mix.byteLength);

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>voice gate browser bench</title>
<script type="module">
import { loadRnnoise, RnnoiseWorkletNode } from "/dist/index.js";

const SR = ${SR};

const b64 = (f32) => {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

const gateOptions = (processorOptions) => ({
  // Exactly the options lib/voice-gate/voice-gate-node.ts builds the node with.
  numberOfInputs: 2,
  numberOfOutputs: 1,
  outputChannelCount: [1],
  channelCount: 1,
  channelCountMode: "explicit",
  processorOptions,
});

window.measure = async () => {
  const raw = new Uint8Array(await (await fetch("/scene.f32")).arrayBuffer());
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

  const START = 0;
  const startFrame = Math.round(START * SR);
  const ctx = new OfflineAudioContext(3, startFrame + samples.length + SR / 2, SR);
  await ctx.audioWorklet.addModule("/dist/rnnoise/workletProcessor.js");
  await ctx.audioWorklet.addModule("/voice-gate-worklet.js");
  const binary = await loadRnnoise({
    url: "/dist/rnnoise.wasm",
    simdUrl: "/dist/rnnoise_simd.wasm",
  });

  const buffer = ctx.createBuffer(1, samples.length, SR);
  buffer.copyToChannel(samples, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary.slice(0) });
  const gate = new AudioWorkletNode(ctx, "pqp-voice-gate", gateOptions({ lookaheadMs: 0 }));
  const gateAlone = new AudioWorkletNode(ctx, "pqp-voice-gate", gateOptions({}));

  const merger = ctx.createChannelMerger(3);
  merger.connect(ctx.destination);
  source.connect(rnnoise);
  rnnoise.connect(merger, 0, 0);
  rnnoise.connect(gate, 0, 0);
  source.connect(gate, 0, 1);
  gate.connect(merger, 0, 1);
  source.connect(gateAlone, 0, 0);
  gateAlone.connect(merger, 0, 2);
  source.start(START);

  // Park the render before the scene starts so the worklet thread is idle long
  // enough for the RNNoise wasm to come up.
  ctx.suspend(0.1).then(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    await ctx.resume();
  });
  const rendered = await ctx.startRendering();
  const channel = (k) =>
    b64(rendered.getChannelData(k).slice(startFrame, startFrame + samples.length));
  return { a: channel(0), b: channel(1), c: channel(2) };
};
</script>`;

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (url === "/scene.f32") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(sceneBytes);
    return;
  }
  if (url === "/voice-gate-worklet.js") {
    res.writeHead(200, { "content-type": TYPES[".js"] });
    res.end(await readFile(gateFile));
    return;
  }
  if (!url.startsWith("/dist/") || url.includes("..")) {
    res.writeHead(404).end();
    return;
  }
  try {
    const file = path.join(distDir, url.slice("/dist/".length));
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

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

const fromB64 = (s) => {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
};

let browser;
let failed = false;
try {
  browser = await chromium.launch();
  browser.on("disconnected", closeServerOnce);
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[page]", m.text());
  });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof window.measure === "function");
  const r = await page.evaluate(() => window.measure());

  const a = fromB64(r.a); // RNNoise alone
  const b = fromB64(r.b); // RNNoise + gate (sidechain)
  const c = fromB64(r.c); // gate alone

  const lag = M.estimateLag(scene.mix, a, Math.round(1.2 * SR), Math.round(1.75 * SR), 4000);
  const aAligned = M.align(a, lag);
  const bAligned = M.align(b, lag);
  const cAligned = M.align(c, 384);
  const gaps = M.gapWindows(scene);
  const keys = M.keyboardInGaps(scene, gaps);
  const worst = (xs) => {
    const v = xs.filter((x) => x !== null);
    return v.length ? Math.min(...v) : null;
  };
  const f = (x) => (x === null ? "-" : x.toFixed(1));

  console.log(
    `browser: ${browser.version()}   RNNoise delay measured: ${((lag / SR) * 1000).toFixed(1)} ms`,
  );
  console.log("");
  console.log("  chain                        gap dB  key dB  onset dB");
  const rows = [
    ["RNNoise", aAligned, scene.mix],
    ["RNNoise + gate (Voz limpa)", bAligned, aAligned],
    ["gate alone (8 ms lookahead)", cAligned, scene.mix],
  ];
  for (const [label, aligned, reference] of rows) {
    console.log(
      `  ${label.padEnd(28)} ${f(M.gapReductionDb(scene.mix, aligned, gaps)).padStart(6)}  ${f(
        M.keyboardPeakReductionDb(scene.mix, aligned, keys),
      ).padStart(6)}  ${f(worst(M.onsetLossDb(scene, reference, aligned))).padStart(7)}`,
    );
  }

  // Smoke assertions: silent branches and clipped words are the failures a
  // wiring mistake produces.
  const energy = (x) => x.reduce((s, v) => s + v * v, 0);
  for (const [name, x] of [
    ["A", a],
    ["B", b],
    ["C", c],
  ]) {
    if (energy(x) < 1e-3) {
      console.error(`FAIL: branch ${name} is silent`);
      failed = true;
    }
  }
  const onsetB = worst(M.onsetLossDb(scene, aAligned, bAligned));
  if (onsetB !== null && onsetB < -1.5) {
    console.error(`FAIL: the gate clipped a word onset by ${onsetB.toFixed(1)} dB`);
    failed = true;
  }
  const gapB = M.gapReductionDb(scene.mix, bAligned, gaps);
  const gapA = M.gapReductionDb(scene.mix, aAligned, gaps);
  if (gapB < gapA + 10) {
    console.error(
      `FAIL: the gate added only ${(gapB - gapA).toFixed(1)} dB over RNNoise in the gaps`,
    );
    failed = true;
  }
} finally {
  await browser?.close();
  closeServerOnce();
}
process.exit(failed ? 1 : 0);

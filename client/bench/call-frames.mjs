/**
 * Frames, paints and raster work per second while alone in a call, from a
 * Chromium trace. The CPU sat outside JavaScript (2.5 % of a core in the page's
 * own profile against 14 % for the renderer process), so this counts what the
 * browser does between our callbacks. Not product code.
 *
 *   BENCH_APP_URL=... BENCH_SERVER_ID=... BENCH_CHANNEL_ID=... node client/bench/call-frames.mjs [seconds]
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4190";
const seconds = Number(process.argv[2] ?? 10);
const target = `${BASE}/app/server/${process.env.BENCH_SERVER_ID}/channel/${process.env.BENCH_CHANNEL_ID}?lang=en`;
const out = process.env.BENCH_TRACE_OUT;

const browser = await chromium.launch({
  headless: true,
  args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      // BENCH_FAKE_AUDIO=quiet.wav: a silent room instead of Chromium's repeating
      // beep, which makes the speaking ring flicker and so is not "alone in a call".
      ...(process.env.BENCH_FAKE_AUDIO ? [`--use-file-for-fake-audio-capture=${process.env.BENCH_FAKE_AUDIO}`] : []),
    ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
const page = await context.newPage();
await page.goto(target, { waitUntil: "load" });
await page.getByRole("button", { name: /lobby/i }).first().dblclick();
await page.getByRole("button", { name: "Disconnect from voice" }).waitFor({ state: "visible", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 5000));
await browser.startTracing(page, {
  categories: ["devtools.timeline", "cc", "viz", "gpu", "blink", "disabled-by-default-devtools.timeline.frame", "benchmark"],
});
await new Promise((r) => setTimeout(r, seconds * 1000));
const buf = await browser.stopTracing();
await browser.close();
const trace = JSON.parse(buf.toString());
if (out) fs.writeFileSync(out, buf);
const events = trace.traceEvents ?? trace;
const counts = new Map();
const dur = new Map();
for (const e of events) {
  const key = `${e.name}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (e.ph === "X" && e.dur) dur.set(key, (dur.get(key) ?? 0) + e.dur);
}
const interesting = [
  "BeginMainThreadFrame", "ProxyMain::BeginMainFrame", "Commit", "UpdateLayerTree", "Layerize", "PrePaint", "Paint",
  "RasterTask", "ImageDecodeTask", "Display::DrawAndSwap", "DrawFrame", "RunTask", "FireAnimationFrame", "UpdateLayoutTree",
  "ScheduledAction::execute", "TimerFire", "FunctionCall", "EventDispatch", "MajorGC", "MinorGC", "HitTest",
  "ThreadControllerImpl::RunTask", "Animation", "CompositeLayers", "TilesManager::Raster",
];
console.log(`trace ${seconds}s, ${events.length} events`);
for (const k of interesting) if (counts.has(k)) console.log(String(Math.round((counts.get(k) / seconds) * 10) / 10).padStart(8), "/s", k.padEnd(34), dur.has(k) ? `${Math.round(dur.get(k) / 1000 / seconds * 10) / 10} ms/s` : "");
const fc = new Map();
for (const e of events) {
  if (e.name !== "FunctionCall") continue;
  const d = e.args?.data ?? {};
  const key = `${d.functionName || "(anon)"} ${String(d.url ?? "").replace(/^https?:\/\/[^/]+/, "")}:${d.lineNumber ?? ""}`;
  fc.set(key, (fc.get(key) ?? 0) + 1);
}
console.log("-- FunctionCall by function");
for (const [k, n] of [...fc].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(String(Math.round((n / seconds) * 10) / 10).padStart(8), "/s", k.slice(0, 150));
console.log("-- top event names by count");
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(Math.round((n / seconds) * 10) / 10).padStart(8), "/s", k);

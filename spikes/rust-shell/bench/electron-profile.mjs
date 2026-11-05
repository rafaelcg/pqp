/* eslint-disable -- spike measurement code outside the workspace, see spikes/rust-shell/README.md */
// Where the renderer's time and heap go in the three hot spots the bench found:
// history held in memory, leaving a channel with that history, and sitting in a
// call. Run against an UNMINIFIED build so function names survive.
//
//   BENCH_APP_URL=http://127.0.0.1:4184 node spikes/rust-shell/bench/electron-profile.mjs
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(here, "../../../electron");
const require = createRequire(path.join(electronRoot, "package.json"));
const { _electron } = require("@playwright/test");
const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4184";
const OUT = process.env.BENCH_OUT ?? tmpdir();
const { BENCH_SERVER_ID: S, BENCH_LIGHT_CHANNEL: L } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function topSelf(profile, n = 25) {
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const total = new Map();
  profile.samples.forEach((id, i) => total.set(id, (total.get(id) ?? 0) + (dt[i] ?? 0)));
  for (const [id, us] of total) {
    const node = byId.get(id);
    const cf = node.callFrame;
    const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const sum = [...self.values()].reduce((a, b) => a + b, 0);
  return {
    totalMs: Math.round(sum / 1000),
    top: [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, us]) => `${Math.round(us / 1000)}ms ${k}`),
  };
}

function topAlloc(sampling, n = 25) {
  const out = new Map();
  const walk = (node, stack) => {
    const cf = node.callFrame;
    const here = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;
    if (node.selfSize) out.set(here, (out.get(here) ?? 0) + node.selfSize);
    for (const c of node.children ?? []) walk(c, stack);
  };
  walk(sampling.profile.head, []);
  const sum = [...out.values()].reduce((a, b) => a + b, 0);
  return {
    totalMB: Math.round(sum / 1048576),
    top: [...out.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, b]) => `${Math.round(b / 1048576 * 10) / 10}MB ${k}`),
  };
}

const dir = mkdtempSync(path.join(tmpdir(), "pqp-prof-"));
const app = await _electron.launch({
  args: [electronRoot, `--user-data-dir=${dir}`, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  env: { ...process.env, PQP_APP_URL: `${BASE}/app/server/${S}/channel/${L}?lang=en`, NODE_ENV: "test" },
});
const page = await app.firstWindow();
await page.waitForFunction(() => document.body?.innerText.includes("o estrela é esse"), null, { timeout: 60_000 });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("HeapProfiler.enable");

await page.getByRole("button", { name: /^off-topic/ }).or(page.getByRole("link", { name: /^off-topic/ })).first().click();
await page.waitForFunction(() => document.body.innerText.includes("const x = 5000"));

// Heap: what is still alive after 2000 rows are mounted.
await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });
await cdp.send("Profiler.start");
for (let i = 0; i < 60; i++) {
  const c = await page.evaluate(() => document.querySelectorAll("article").length);
  if (c >= 2000) break;
  await page.evaluate(() => {
    let el = document.querySelector("article")?.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 10)) el = el.parentElement;
    if (el) el.scrollTop = 0;
  });
  await page.waitForFunction((n) => document.querySelectorAll("article").length > n, c, { timeout: 5000 }).catch(() => {});
}
const loadCpu = await cdp.send("Profiler.stop");
await cdp.send("HeapProfiler.collectGarbage");
const heap = await cdp.send("HeapProfiler.stopSampling");

// CPU: leaving the heavy channel.
await cdp.send("Profiler.start");
const t0 = Date.now();
await page.getByRole("button", { name: /^general/ }).or(page.getByRole("link", { name: /^general/ })).first().click();
await page.waitForFunction(() => document.querySelector("main")?.innerText.includes("o estrela é esse"), null, { polling: "raf" });
const leaveMs = Date.now() - t0;
const leaveCpu = await cdp.send("Profiler.stop");

// CPU: alone in a call for 10 s.
await page.getByRole("button", { name: /lobby/i }).first().dblclick();
await page.getByRole("button", { name: /Disconnect from voice|Leave/ }).first().waitFor({ timeout: 30_000 });
await sleep(3000);
await cdp.send("Profiler.start");
await sleep(10_000);
const callCpu = await cdp.send("Profiler.stop");

writeFileSync(path.join(OUT, "leave.cpuprofile"), JSON.stringify(leaveCpu.profile));
writeFileSync(path.join(OUT, "call.cpuprofile"), JSON.stringify(callCpu.profile));
console.log(JSON.stringify({
  historyLoadCpu: topSelf(loadCpu.profile, 15),
  liveHeapAfterHistory: topAlloc(heap, 25),
  leaveMs,
  leaveCpu: topSelf(leaveCpu.profile, 25),
  callCpu10s: topSelf(callCpu.profile, 25),
}, null, 2));
await app.close();
rmSync(dir, { recursive: true, force: true });

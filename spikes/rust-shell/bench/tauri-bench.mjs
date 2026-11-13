/* eslint-disable -- spike measurement code outside the workspace, see spikes/rust-shell/README.md */
// Drives the Tauri spike: a loopback collector receives what src/probe.js
// reports from inside the page, and this script samples memory and CPU of the
// app process PLUS the WebKit helper processes it caused (WebContent,
// Networking, GPU), which macOS runs as XPC services outside its process tree.
// They are identified as the com.apple.WebKit.* processes that did not exist
// before launch, so close Safari and other WebKit apps first for a clean read.
//
//   TAURI_BIN=... PQP_APP_URL=... node spikes/rust-shell/bench/tauri-bench.mjs [probe|startup|full] [runs]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { footprintFor, psTable, cpuSeconds, mb } from "./footprint.mjs";

const BIN = process.env.TAURI_BIN;
const PORT = 47999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const events = [];
const waiters = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(204, { "access-control-allow-origin": "*" });
    res.end();
    try {
      const e = JSON.parse(body);
      events.push(e);
      const i = waiters.findIndex((w) => w.k === e.k);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(e);
    } catch {}
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const waitFor = (k, ms = 120_000) =>
  new Promise((resolve, reject) => {
    const seen = events.find((e) => e.k === k);
    if (seen) return resolve(seen);
    waiters.push({ k, resolve });
    setTimeout(() => reject(new Error(`timeout waiting for ${k}`)), ms);
  });

const webkitPids = () => new Set(psTable().filter((p) => p.comm.includes("com.apple.WebKit")).map((p) => p.pid));

function launch(scenario, extraEnv = {}) {
  events.length = 0;
  const before = webkitPids();
  const t0 = Date.now();
  const child = spawn(BIN, [], {
    env: { ...process.env, PQP_COLLECTOR: `http://127.0.0.1:${PORT}`, PQP_SCENARIO: scenario, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const procs = () => {
    const table = psTable();
    const mine = table.filter((p) => p.pid === child.pid).map((p) => ({ pid: p.pid, type: "App" }));
    const helpers = table
      .filter((p) => p.comm.includes("com.apple.WebKit") && !before.has(p.pid))
      .map((p) => ({ pid: p.pid, type: p.comm.split("com.apple.WebKit.").pop() }));
    return [...mine, ...helpers];
  };
  return { child, t0, procs };
}

function memory(procs) {
  const fp = footprintFor(procs);
  const byType = {};
  for (const r of fp.rows) byType[r.type] = (byType[r.type] ?? 0) + (r.footprint ?? 0);
  return { totalMB: mb(fp.total), byTypeMB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, mb(v)])), processCount: procs.length };
}

async function cpu(procs, ms) {
  const a = procs.map((p) => cpuSeconds(p.pid));
  await sleep(ms);
  const b = procs.map((p) => cpuSeconds(p.pid));
  let total = 0;
  const perType = {};
  procs.forEach((p, i) => {
    if (a[i] == null || b[i] == null) return;
    const pct = ((b[i] - a[i]) / (ms / 1000)) * 100;
    perType[p.type] = Math.round(((perType[p.type] ?? 0) + pct) * 100) / 100;
    total += pct;
  });
  return { totalPct: Math.round(total * 100) / 100, perType };
}

async function stop(app) {
  app.child.kill("SIGTERM");
  await new Promise((r) => app.child.on("exit", r));
  await sleep(1500);
}

const mode = process.argv[2] ?? "probe";
const out = {};
if (mode === "probe") {
  const app = launch("", { PQP_JOIN: process.env.PQP_JOIN ?? "" });
  const content = await waitFor("content");
  out.contentMs = content.t - app.t0;
  for (const k of ["caps", "rtcLoopback", "getUserMedia", "getDisplayMediaNoGesture"]) {
    out[k] = (await waitFor(k, 60_000).catch((e) => ({ v: String(e) }))).v;
  }
  if (process.env.PQP_JOIN === "1") out.joined = (await waitFor("joined", 30_000).catch((e) => ({ v: String(e) }))).v;
  out.mem = memory(app.procs());
  await stop(app);
} else if (mode === "startup") {
  const runs = [];
  for (let i = 0; i < Number(process.argv[3] ?? 5); i++) {
    const app = launch("none");
    const content = await waitFor("content");
    await sleep(3000);
    runs.push({ contentMs: content.t - app.t0, memMB: memory(app.procs()).totalMB });
    await stop(app);
  }
  out.runs = runs;
  out.median = { contentMs: median(runs.map((r) => r.contentMs)), memMB: median(runs.map((r) => r.memMB)) };
} else {
  const app = launch("full");
  const content = await waitFor("content");
  out.startupContentMs = content.t - app.t0;
  await sleep(10_000);
  out.memIdleLight = memory(app.procs());
  out.cpuIdleLight30s = await cpu(app.procs(), 30_000);
  out.switch = (await waitFor("switch", 180_000)).v;
  out.switch.medianHeavy = median(out.switch.toHeavy);
  out.switch.medianLight = median(out.switch.toLight);
  out.sweepAt50 = (await waitFor("sweepAt50")).v;
  out.history = (await waitFor("history", 300_000)).v;
  out.memHeavy = memory(app.procs());
  out.sweepAtHistory = (await waitFor("sweepAtHistory", 300_000)).v;
  out.switchFromHeavyMs = (await waitFor("switchFromHeavyMs")).v;
  out.switchBackToHeavyMs = (await waitFor("switchBackToHeavyMs")).v;
  await waitFor("leftHeavy");
  out.memAfterLeavingHeavy = memory(app.procs());
  out.cpuIdleAfterHeavy30s = await cpu(app.procs(), 30_000);
  await waitFor("done");
  await stop(app);
}
console.log(JSON.stringify(out, null, 2));
server.close();

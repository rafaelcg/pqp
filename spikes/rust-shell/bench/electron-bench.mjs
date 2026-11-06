/* eslint-disable -- spike measurement code outside the workspace, see spikes/rust-shell/README.md */
// Measures the real Electron shell (electron/main.js, unchanged) against a local
// production build of the web client and a local API with the dev auth bypass.
//
//   node spikes/rust-shell/bench/electron-bench.mjs <scenario> [runs]
//   scenario: startup-cold | startup-warm | full
//
// Env: BENCH_APP_URL (base, default http://127.0.0.1:4183), BENCH_SERVER_ID,
// BENCH_LIGHT_CHANNEL, BENCH_HEAVY_CHANNEL, BENCH_LIGHT_MARKER, BENCH_HEAVY_MARKER.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { footprintFor, cpuSeconds, mb } from "./footprint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(here, "../../../electron");
const require = createRequire(path.join(electronRoot, "package.json"));
const { _electron } = require("@playwright/test");

const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4183";
const SERVER = process.env.BENCH_SERVER_ID;
const LIGHT = process.env.BENCH_LIGHT_CHANNEL;
const HEAVY = process.env.BENCH_HEAVY_CHANNEL;
const LIGHT_MARKER = process.env.BENCH_LIGHT_MARKER ?? "o estrela é esse";
const HEAVY_MARKER = process.env.BENCH_HEAVY_MARKER ?? "const x = 5000";
const startUrl = `${BASE}/app/server/${SERVER}/channel/${LIGHT}?lang=en`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function launch(userDataDir) {
  const t0 = Date.now();
  const app = await _electron.launch({
    args: [
      electronRoot,
      `--user-data-dir=${userDataDir}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
    env: { ...process.env, PQP_APP_URL: startUrl, NODE_ENV: "test" },
  });
  const page = await app.firstWindow();
  const tWindow = Date.now();
  // The first frame that shows the real thing: the channel's latest message.
  const tContent = await page.waitForFunction(
    (marker) => (document.body?.textContent.includes(marker) ? Date.now() : false),
    LIGHT_MARKER,
    { polling: "raf", timeout: 60_000 },
  ).then((h) => h.jsonValue());
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      timeOrigin: performance.timeOrigin,
      dcl: n?.domContentLoadedEventEnd,
      load: n?.loadEventEnd,
      fcp: fcp?.startTime,
      transfer: performance
        .getEntriesByType("resource")
        .reduce((s, r) => s + (r.transferSize || 0), 0),
      resources: performance.getEntriesByType("resource").length,
      jsKB: Math.round(
        performance
          .getEntriesByType("resource")
          .filter((r) => r.name.endsWith(".js"))
          .reduce((s, r) => s + (r.decodedBodySize || 0), 0) / 1024,
      ),
      bigJs: performance
        .getEntriesByType("resource")
        .filter((r) => r.name.endsWith(".js") && r.decodedBodySize > 150_000)
        .map((r) => `${r.name.split("/").pop()} ${Math.round(r.decodedBodySize / 1024)}KB`),
    };
  });
  return {
    app,
    page,
    startup: {
      windowMs: tWindow - t0,
      navStartMs: Math.round(nav.timeOrigin - t0),
      fcpMs: nav.fcp ? Math.round(nav.timeOrigin + nav.fcp - t0) : null,
      dclMs: nav.dcl ? Math.round(nav.timeOrigin + nav.dcl - t0) : null,
      contentMs: tContent - t0,
      transferKB: Math.round(nav.transfer / 1024),
      resources: nav.resources,
      jsKB: nav.jsKB,
      bigJs: nav.bigJs.join(", "),
    },
  };
}

async function processes(app) {
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics());
  return metrics.map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? m.serviceName }));
}

async function memory(app) {
  const procs = await processes(app);
  const fp = footprintFor(procs);
  const byType = {};
  for (const r of fp.rows) byType[r.type] = (byType[r.type] ?? 0) + (r.footprint ?? 0);
  return {
    totalMB: mb(fp.total),
    byTypeMB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, mb(v)])),
    processCount: procs.length,
  };
}

/** Average CPU % (of one core) across every app process over `ms`. */
async function idleCpu(app, ms) {
  const procs = await processes(app);
  const before = procs.map((p) => cpuSeconds(p.pid));
  await sleep(ms);
  const after = procs.map((p) => cpuSeconds(p.pid));
  const perType = {};
  let total = 0;
  procs.forEach((p, i) => {
    if (before[i] == null || after[i] == null) return;
    const pct = ((after[i] - before[i]) / (ms / 1000)) * 100;
    perType[p.type] = Math.round(((perType[p.type] ?? 0) + pct) * 100) / 100;
    total += pct;
  });
  return { totalPct: Math.round(total * 100) / 100, perType };
}

async function rendererStats(page) {
  return page.evaluate(() => ({
    domNodes: document.getElementsByTagName("*").length,
    articles: document.querySelectorAll("article").length,
    jsHeapMB: performance.memory
      ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10
      : null,
  }));
}

// Not getByRole: Playwright computes an accessible name for every node on the
// page to answer it, which on a 100k-node transcript costs seconds of ITS time
// and would be billed to the app. A plain DOM walk over the sidebar is free.
async function clickChannel(page, name) {
  const ok = await page.evaluate((n) => {
    const els = [...document.querySelectorAll("a, button")];
    const hit = els.find((e) => (e.textContent ?? "").trim().startsWith(n) && !e.closest("main"));
    hit?.click();
    return Boolean(hit);
  }, name);
  if (!ok) throw new Error(`no sidebar entry for ${name}`);
}

async function switchTo(page, name, marker) {
  const t0 = await page.evaluate(() => Date.now());
  await clickChannel(page, name);
  const t1 = await page
    .waitForFunction(
      (m) => {
        // textContent, not innerText: innerText forces layout of the whole
        // transcript on every poll.
        const main = document.querySelector("main") ?? document.body;
        return main.textContent.includes(m) ? Date.now() : false;
      },
      marker,
      { polling: "raf", timeout: 30_000 },
    )
    .then((h) => h.jsonValue());
  return t1 - t0;
}

/** Scroll the transcript top to bottom, rAF by rAF, and time every frame. */
async function scrollSweep(page) {
  return page.evaluate(async () => {
    const first = document.querySelector("article");
    let el = first?.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 10 && getComputedStyle(el).overflowY !== "visible")) {
      el = el.parentElement;
    }
    if (!el) return null;
    const longTasks = [];
    let obs;
    try {
      obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration)));
      obs.observe({ type: "longtask", buffered: false });
    } catch {}
    el.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const frames = [];
    const step = 120;
    let last = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        frames.push(now - last);
        last = now;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return resolve();
        el.scrollTop += step;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    obs?.disconnect();
    frames.shift();
    const sorted = [...frames].sort((a, b) => a - b);
    const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
    return {
      scrollHeight: el.scrollHeight,
      frames: frames.length,
      p50: pct(0.5),
      p95: pct(0.95),
      max: Math.round(sorted[sorted.length - 1] * 10) / 10,
      over33ms: frames.filter((f) => f > 33.4).length,
      longTasks: longTasks.length,
      longTaskMaxMs: longTasks.length ? Math.round(Math.max(...longTasks)) : 0,
    };
  });
}

/** Pull history by scrolling to the top until `target` rows are mounted. */
async function loadHistory(page, target) {
  const t0 = Date.now();
  let pages = 0;
  for (; pages < 200; pages++) {
    const count = await page.evaluate(() => document.querySelectorAll("article").length);
    if (count >= target) break;
    await page.evaluate(() => {
      const first = document.querySelector("article");
      let el = first?.parentElement;
      while (el && !(el.scrollHeight > el.clientHeight + 10)) el = el.parentElement;
      if (el) el.scrollTop = 0;
    });
    try {
      await page.waitForFunction(
        (c) => document.querySelectorAll("article").length > c,
        count,
        { timeout: 5000, polling: 50 },
      );
    } catch {
      // A "load older" button may be the trigger instead of the scroll.
      const btn = page.getByRole("button", { name: /older|anteriores|load more/i }).first();
      if (await btn.isVisible().catch(() => false)) await btn.click();
      else break;
    }
  }
  const count = await page.evaluate(() => document.querySelectorAll("article").length);
  return { rows: count, pages, ms: Date.now() - t0 };
}

async function joinCall(page) {
  const t0 = await page.evaluate(() => Date.now());
  await page.getByRole("button", { name: /lobby/i }).first().dblclick();
  const joinBtn = page.getByRole("button", { name: "Join Voice" });
  if (await joinBtn.isVisible({ timeout: 1500 }).catch(() => false)) await joinBtn.click();
  await page
    .getByRole("button", { name: /Disconnect from voice|Leave/ })
    .first()
    .waitFor({ timeout: 30_000 });
  const t1 = await page.evaluate(() => Date.now());
  return t1 - t0;
}

async function main() {
  const scenario = process.argv[2] ?? "full";
  const runs = Number(process.argv[3] ?? 1);
  const results = [];
  if (scenario === "startup-cold" || scenario === "startup-warm") {
    const shared = mkdtempSync(path.join(tmpdir(), "pqp-bench-"));
    if (scenario === "startup-warm") {
      const { app } = await launch(shared); // prime caches + service worker
      await sleep(4000);
      await app.close();
    }
    for (let i = 0; i < runs; i++) {
      const dir = scenario === "startup-cold" ? mkdtempSync(path.join(tmpdir(), "pqp-bench-")) : shared;
      const { app, startup } = await launch(dir);
      await sleep(3000);
      const mem = await memory(app);
      results.push({ ...startup, memMB: mem.totalMB });
      await app.close();
      if (scenario === "startup-cold") rmSync(dir, { recursive: true, force: true });
    }
    rmSync(shared, { recursive: true, force: true });
    const keys = Object.keys(results[0]);
    console.log(JSON.stringify({ scenario, runs: results, median: Object.fromEntries(keys.map((k) => [k, median(results.map((r) => r[k]))])) }, null, 2));
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "pqp-bench-"));
  const out = {};
  const { app, page, startup } = await launch(dir);
  out.startup = startup;
  await sleep(10_000);
  out.memIdleLight = await memory(app);
  out.cpuIdleLight30s = await idleCpu(app, 30_000);
  out.rendererLight = await rendererStats(page);

  // Channel switches: heavy (5000 msgs, first page 50) and back, 5 times.
  const toHeavy = [];
  const toLight = [];
  for (let i = 0; i < 5; i++) {
    toHeavy.push(await switchTo(page, "off-topic", HEAVY_MARKER));
    await sleep(500);
    toLight.push(await switchTo(page, "general", LIGHT_MARKER));
    await sleep(500);
  }
  out.switchMs = { toHeavy, toLight, medianHeavy: median(toHeavy), medianLight: median(toLight) };

  await switchTo(page, "off-topic", HEAVY_MARKER);
  await sleep(1000);
  out.sweepAt50 = await scrollSweep(page);
  out.history = await loadHistory(page, Number(process.env.BENCH_HISTORY ?? 2000));
  await sleep(2000);
  out.rendererHeavy = await rendererStats(page);
  out.memHeavy = await memory(app);
  out.sweepAtHistory = await scrollSweep(page);
  // Switching away from and back to a channel holding that much history.
  out.switchFromHeavyMs = await switchTo(page, "general", LIGHT_MARKER);
  out.switchBackToHeavyMs = await switchTo(page, "off-topic", HEAVY_MARKER);
  await switchTo(page, "general", LIGHT_MARKER);
  await sleep(3000);
  out.memAfterLeavingHeavy = await memory(app);
  out.cpuIdleAfterHeavy30s = await idleCpu(app, 30_000);

  try {
    out.joinCallMs = await joinCall(page);
    await sleep(5000);
    out.memInCall = await memory(app);
    out.cpuInCall30s = await idleCpu(app, 30_000);
  } catch (e) {
    out.joinCallError = String(e).slice(0, 300);
  }
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

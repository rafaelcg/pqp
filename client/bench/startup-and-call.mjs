/**
 * Startup transfer and CPU-while-alone-in-a-call bench, headless Chromium.
 *
 *   node client/bench/startup-and-call.mjs startup [runs]
 *   node client/bench/startup-and-call.mjs call [seconds]
 *
 * Needs a local API with the dev auth bypass and a production client build
 * made with VITE_DEV_AUTH_BYPASS=true and VITE_API_URL / VITE_WS_URL pointing
 * at it, served with brotli like the CDN does (any static server will do for
 * the page-weight numbers; the reported `wireKB` is what crossed the loopback,
 * so serve it compressed). Environment:
 *
 *   BENCH_APP_URL      default http://127.0.0.1:4190
 *   BENCH_SERVER_ID    the server to open
 *   BENCH_CHANNEL_ID   a text channel with a recognisable latest message
 *   BENCH_MARKER       text of that latest message (the "first message" probe)
 *   BENCH_VOICE_NAME   the voice channel's name, default "Lobby"
 *   BENCH_CPU_THROTTLE CDP CPU throttling rate for the startup scenario, default 1
 *   BENCH_NET          "4g": 40 ms latency and 12 Mbit/s down, so the bytes cost what they
 *                      cost a person; unset, the loopback is free and only CPU shows
 *
 * `startup`: cold (fresh profile) and warm (second load in the same profile)
 * time from navigation start to the first message in the DOM, requests, bytes
 * on the wire, JS decoded, long tasks.
 *
 * `call`: joins the voice channel with a fake microphone, alone, and over the
 * window reports the renderer's own accounting (script, layout, style, task
 * seconds from CDP) and the CPU seconds of every browser process by type.
 * Nothing here is product code and nothing imports from `src/`.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4190";
const SERVER = process.env.BENCH_SERVER_ID;
const CHANNEL = process.env.BENCH_CHANNEL_ID;
const MARKER = process.env.BENCH_MARKER ?? "Lobby embaixo se quiser";
const VOICE = process.env.BENCH_VOICE_NAME ?? "Lobby";
const THROTTLE = Number(process.env.BENCH_CPU_THROTTLE ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// BENCH_APPS="before=http://127.0.0.1:4190,after=http://127.0.0.1:4191" runs the
// startup scenario on each build in turn, interleaved, so a loaded machine hits
// both the same way. Without it, BENCH_APP_URL is the only build.
const APPS = (process.env.BENCH_APPS ?? `build=${BASE}`)
  .split(",")
  .map((x) => x.split("="))
  .map(([name, base]) => ({ name, base }));
const pathFor = (base) => `${base}/app/server/${SERVER}/channel/${CHANNEL}?lang=en`;
const url = pathFor(BASE);

function psTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,cputime=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .trim()
    .split("\n")
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
      if (!m) return null;
      let s = 0;
      for (const p of m[3].split(/[-:]/).map(Number)) s = s * 60 + p;
      return { pid: +m[1], ppid: +m[2], cpuS: s, rssMB: +m[4] / 1024, cmd: m[5] };
    })
    .filter(Boolean);
}

/** Every browser process with its CPU seconds, straight from Chromium (no ps rounding). */
async function browserProcesses(browser) {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  const rss = new Map(psTable().map((p) => [p.pid, p.rssMB]));
  return processInfo.map((p) => ({ type: p.type, pid: p.id, cpuS: p.cpuTime, rssMB: rss.get(p.id) ?? 0 }));
}

function byType(procs, key) {
  const o = {};
  for (const p of procs) o[p.type] = (o[p.type] ?? 0) + p[key];
  return o;
}

const PROBE = `
  window.__bench = { firstMessageAt: null, longTasks: [], rafCount: 0 };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__bench.longTasks.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const look = () => {
    if (window.__bench.firstMessageAt == null && document.body && document.body.textContent.includes(${JSON.stringify(MARKER)})) {
      window.__bench.firstMessageAt = performance.now();
      return;
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
`;

async function oneLoad(context, label, target = url) {
  const page = await context.newPage();
  await page.addInitScript(PROBE);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  if (process.env.BENCH_NET === "4g") {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: (12 * 1024 * 1024) / 8,
      uploadThroughput: (6 * 1024 * 1024) / 8,
    });
  }
  if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  let requests = 0;
  let wire = 0;
  const jsFiles = new Set();
  const list = new Map();
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.request.url.startsWith("http")) requests += 1;
    list.set(e.requestId, { url: e.request.url.replace(BASE, ""), at: e.timestamp, wire: 0 });
  });
  cdp.on("Network.responseReceived", (e) => {
    if (e.type === "Script") jsFiles.add(e.response.url.split("/").pop());
  });
  cdp.on("Network.loadingFinished", (e) => {
    wire += e.encodedDataLength;
    const row = list.get(e.requestId);
    if (row) {
      row.wire = e.encodedDataLength;
      row.end = e.timestamp;
    }
  });
  await page.goto(target, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__bench?.firstMessageAt != null, null, {
    timeout: 60_000,
    polling: 50,
  });
  const pm = Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
  );
  const r = await page.evaluate(() => {
    const res = performance.getEntriesByType("resource");
    return {
      firstMessageMs: Math.round(window.__bench.firstMessageAt),
      fcpMs: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1),
      jsDecodedKB: Math.round(
        res.filter((x) => x.initiatorType === "script" || x.name.endsWith(".js")).reduce((s, x) => s + x.decodedBodySize, 0) / 1024,
      ),
      longTaskMs: Math.round(window.__bench.longTasks.reduce((s, x) => s + x, 0)),
      longTasks: window.__bench.longTasks.length,
    };
  });
  // Let trailing requests (prefetches) settle, they count toward "before the first message" only if earlier.
  await sleep(1500);
  if (process.env.BENCH_LIST && label === "cold") {
    const rows = [...list.values()].sort((a, b) => a.at - b.at);
    const t0 = rows[0]?.at ?? 0;
    for (const r of rows) {
      console.error(`${String(Math.round((r.at - t0) * 1000)).padStart(5)}ms +${String(Math.round(((r.end ?? r.at) - r.at) * 1000)).padStart(4)} ${String(Math.round(r.wire / 1024)).padStart(5)}KB ${r.url.slice(0, 90)}`);
    }
  }
  const settled = {
    requests,
    wireKB: Math.round(wire / 1024),
    jsFiles: jsFiles.size,
    mainThreadMs: Math.round(pm.TaskDuration * 1000),
    scriptMs: Math.round(pm.ScriptDuration * 1000),
  };
  await page.close();
  return { label, ...r, ...settled };
}

async function startup(runs) {
  const results = {};
  for (const app of APPS) results[app.name] = { cold: [], warm: [] };
  for (let i = 0; i < runs; i++) {
    for (const app of APPS) {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      results[app.name].cold.push(await oneLoad(context, "cold", pathFor(app.base)));
      results[app.name].warm.push(await oneLoad(context, "warm", pathFor(app.base)));
      await browser.close();
    }
  }
  const summarize = (rows) => ({
    firstMessageMs: median(rows.map((r) => r.firstMessageMs)),
    mainThreadMsAtFirstMessage: median(rows.map((r) => r.mainThreadMs)),
    scriptMsAtFirstMessage: median(rows.map((r) => r.scriptMs)),
    requests: median(rows.map((r) => r.requests)),
    wireKB: median(rows.map((r) => r.wireKB)),
    jsDecodedKB: median(rows.map((r) => r.jsDecodedKB)),
    jsFiles: median(rows.map((r) => r.jsFiles)),
    runs: rows.length,
  });
  const out = {};
  for (const app of APPS) {
    out[app.name] = { cold: summarize(results[app.name].cold), warm: summarize(results[app.name].warm) };
  }
  console.log(JSON.stringify(out, null, 2));
  if (process.env.BENCH_RAW) console.log(JSON.stringify(results));
}

async function call(seconds) {
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  await page.addInitScript(PROBE);
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__bench?.firstMessageAt != null, null, { timeout: 60_000 });
  await page.getByRole("button", { name: new RegExp(VOICE, "i") }).first().dblclick();
  await page
    .getByRole("button", { name: "Disconnect from voice" })
    .waitFor({ state: "visible", timeout: 30_000 });
  await sleep(5000); // settle: join, first stats, first paint of the stage
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metric = async () =>
    Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  // rAF callbacks per second the page actually runs, counted by wrapping rAF.
  await page.evaluate(() => {
    window.__rafHits = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      orig((t) => {
        window.__rafHits += 1;
        cb(t);
      });
    window.__timerHits = 0;
    const origSI = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...a) =>
      origSI((...x) => {
        window.__timerHits += 1;
        return fn(...x);
      }, ms, ...a);
  });
  const m0 = await metric();
  const p0 = await browserProcesses(browser);
  const t0 = Date.now();
  await sleep(seconds * 1000);
  const wall = (Date.now() - t0) / 1000;
  const m1 = await metric();
  const p1 = await browserProcesses(browser);
  const d = (k) => Math.round(((m1[k] - m0[k]) / wall) * 1000) / 10; // percent of one core
  const cpu0 = byType(p0, "cpuS");
  const cpu1 = byType(p1, "cpuS");
  const cpuPct = Object.fromEntries(
    Object.keys(cpu1).map((k) => [k, Math.round((((cpu1[k] ?? 0) - (cpu0[k] ?? 0)) / wall) * 1000) / 10]),
  );
  const hits = await page.evaluate(() => ({ raf: window.__rafHits, timers: window.__timerHits }));
  const speakingRings = await page.evaluate(() => document.getElementsByTagName("*").length);
  console.log(
    JSON.stringify(
      {
        seconds: Math.round(wall),
        rendererPct: { task: d("TaskDuration"), script: d("ScriptDuration"), layout: d("LayoutDuration"), style: d("RecalcStyleDuration") },
        processCpuPct: cpuPct,
        totalCpuPct: Math.round(Object.values(cpuPct).reduce((s, x) => s + x, 0) * 10) / 10,
        rssMBEnd: Object.fromEntries(Object.entries(byType(p1, "rssMB")).map(([k, v]) => [k, Math.round(v)])),
        jsHeapMB: Math.round(m1.JSHeapUsedSize / 1048576),
        domNodes: speakingRings,
        layoutCount: m1.LayoutCount - m0.LayoutCount,
        styleRecalcCount: m1.RecalcStyleCount - m0.RecalcStyleCount,
        rafPerSecond: Math.round(hits.raf / wall),
        intervalCallbacksPerSecond: Math.round(hits.timers / wall),
      },
      null,
      2,
    ),
  );
  await browser.close();
}

const [scenario, arg] = process.argv.slice(2);
if (!SERVER || !CHANNEL) {
  console.error("set BENCH_SERVER_ID and BENCH_CHANNEL_ID");
  process.exit(2);
}
if (scenario === "startup") await startup(Number(arg ?? 5));
else if (scenario === "call") await call(Number(arg ?? 60));
else {
  console.error("scenario: startup | call");
  process.exit(2);
}

/**
 * Where the main thread goes between navigation and the first message.
 *
 *   BENCH_APP_URL=... BENCH_SERVER_ID=... BENCH_CHANNEL_ID=... node client/bench/startup-profile.mjs
 *
 * A CDP CPU profile of one cold load, summed by file (self time) and by the
 * most expensive functions, plus the browser's own per-category time from the
 * trace (script, style, layout, paint, parse, compile). Not product code.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4190";
const target = `${BASE}/app/server/${process.env.BENCH_SERVER_ID}/channel/${process.env.BENCH_CHANNEL_ID}?lang=en`;
const MARKER = process.env.BENCH_MARKER ?? "Lobby embaixo se quiser";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.addInitScript(`
  window.__t = null;
  const look = () => {
    if (window.__t == null && document.body && document.body.textContent.includes(${JSON.stringify(MARKER)})) { window.__t = performance.now(); return; }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
`);
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await page.goto(target, { waitUntil: "commit" });
await page.waitForFunction(() => window.__t != null, null, { timeout: 60_000, polling: 50 });
const { profile } = await cdp.send("Profiler.stop");
await browser.close();

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
const byFile = new Map();
const byFn = [];
let total = 0;
let idle = 0;
for (const [id, us] of self) {
  const n = byId.get(id);
  const f = n.callFrame;
  if (f.functionName === "(idle)" || f.functionName === "(program)") {
    idle += us;
    continue;
  }
  total += us;
  const file = f.url ? f.url.replace(/^https?:\/\/[^/]+/, "") : `(${f.functionName})`;
  byFile.set(file, (byFile.get(file) ?? 0) + us);
  byFn.push({ us, fn: `${f.functionName || "(anon)"} ${file}:${f.lineNumber}` });
}
const ms = (us) => Math.round(us / 100) / 10;
// Inclusive time per node, to see what each module's top level and each render costs.
const incl = new Map();
const parentOf = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
for (const [id, us] of self) {
  for (let cur = id; cur != null; cur = parentOf.get(cur)) incl.set(cur, (incl.get(cur) ?? 0) + us);
}
const depthOf = (id) => { let d = 0; for (let c = parentOf.get(id); c != null; c = parentOf.get(c)) d++; return d; };
console.log("-- inclusive (depth <= 9, > 6 ms)");
const rows = [...incl].map(([id, us]) => ({ id, us, d: depthOf(id), f: byId.get(id).callFrame })).filter((r) => r.us > 6000 && r.d <= 9 && !["(root)", "(program)", "(idle)"].includes(r.f.functionName));
rows.sort((a, b) => a.id - b.id);
for (const r of rows) console.log(" ".repeat(r.d) + String(ms(r.us)) + " " + (r.f.functionName || "(anon)") + " " + (r.f.url || "").replace(/^https?:\/\/[^/]+/, "") + ":" + r.f.lineNumber);
console.log(`active self time ${ms(total)} ms (idle/program ${ms(idle)} ms)`);
console.log("-- by file");
for (const [file, us] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(String(ms(us)).padStart(7), file);
console.log("-- top functions");
for (const r of byFn.sort((a, b) => b.us - a.us).slice(0, 25)) console.log(String(ms(r.us)).padStart(7), r.fn.slice(0, 120));

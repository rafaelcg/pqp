/**
 * CPU profile of the page while alone in a call, against an UNMINIFIED build
 * (`vite build --minify false`) so function names are real. Prints self time by
 * function and by file, and the React components that rendered most. Not
 * product code.
 *
 *   BENCH_APP_URL=... BENCH_SERVER_ID=... BENCH_CHANNEL_ID=... node client/bench/call-profile.mjs [seconds]
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4193";
const seconds = Number(process.argv[2] ?? 20);
const target = `${BASE}/app/server/${process.env.BENCH_SERVER_ID}/channel/${process.env.BENCH_CHANNEL_ID}?lang=en`;

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
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
await cdp.send("Profiler.start");
await new Promise((r) => setTimeout(r, seconds * 1000));
const { profile } = await cdp.send("Profiler.stop");
await browser.close();

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parentOf = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
const self = new Map();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const ms = (us) => Math.round(us / 100) / 10;
let active = 0;
let idle = 0;
const fnSelf = new Map();
const fileSelf = new Map();
const fnIncl = new Map();
for (const [id, us] of self) {
  const f = byId.get(id).callFrame;
  if (f.functionName === "(idle)" || f.functionName === "(program)") {
    idle += us;
    continue;
  }
  active += us;
  const file = (f.url || `(${f.functionName})`).replace(/^https?:\/\/[^/]+/, "");
  const key = `${f.functionName || "(anon)"} ${file}:${f.lineNumber}`;
  fnSelf.set(key, (fnSelf.get(key) ?? 0) + us);
  fileSelf.set(file, (fileSelf.get(file) ?? 0) + us);
  const seen = new Set();
  for (let cur = id; cur != null; cur = parentOf.get(cur)) {
    const cf = byId.get(cur).callFrame;
    const k = `${cf.functionName || "(anon)"} ${(cf.url || "").replace(/^https?:\/\/[^/]+/, "")}:${cf.lineNumber}`;
    if (seen.has(k)) continue;
    seen.add(k);
    fnIncl.set(k, (fnIncl.get(k) ?? 0) + us);
  }
}
console.log(`window ${seconds}s: active ${ms(active)} ms = ${Math.round((active / 1000 / (seconds * 1000)) * 1000) / 10}% of one core; idle ${ms(idle)} ms`);
console.log("-- self time by function");
for (const [k, us] of [...fnSelf].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(String(ms(us)).padStart(8), k.slice(0, 130));
console.log("-- inclusive time (functions of ours, not React internals)");
for (const [k, us] of [...fnIncl]
  .filter(([k]) => /\/assets\/(App|index)/.test(k) && !/^(commitRoot|performWork|renderRoot|beginWork|performUnitOfWork|workLoop|flushWork|performWorkUntilDeadline|(anon) )/.test(k))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)) console.log(String(ms(us)).padStart(8), k.slice(0, 130));

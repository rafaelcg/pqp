/**
 * Who keeps the page busy while alone in a call: the call sites of
 * requestAnimationFrame, setInterval and setTimeout, and which elements get
 * attribute or text changes, counted over a window. Not product code.
 *
 *   BENCH_APP_URL=... BENCH_SERVER_ID=... BENCH_CHANNEL_ID=... node client/bench/call-who-wakes.mjs [seconds]
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.BENCH_APP_URL ?? "http://127.0.0.1:4190";
const seconds = Number(process.argv[2] ?? 15);
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
await page.evaluate(() => {
  const site = (skip = 2) => {
    const lines = (new Error().stack ?? "").split("\n").slice(skip, skip + 3);
    return lines.map((l) => l.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+/, "")).join(" < ");
  };
  const counts = { raf: {}, interval: {}, timeout: {}, mut: {}, anim: {} };
  const bump = (bucket, key) => (counts[bucket][key] = (counts[bucket][key] ?? 0) + 1);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    bump("raf", site());
    return raf(cb);
  };
  const st = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...a) => {
    bump("timeout", `${ms ?? 0}ms ${site()}`);
    return st(fn, ms, ...a);
  };
  const si = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...a) => {
    const where = site();
    return si((...x) => {
      bump("interval", `${ms}ms ${where}`);
      return fn(...x);
    }, ms, ...a);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const tag = el ? `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className?.baseVal ?? el.className ?? "").split(" ").slice(0, 3).join(".")}` : "?";
      bump("mut", `${r.type}${r.attributeName ? ":" + r.attributeName : ""} ${tag}`);
    }
  }).observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true });
  // Running CSS animations and transitions, sampled once a second.
  setInterval(() => {
    for (const a of document.getAnimations()) {
      const t = a.effect?.target;
      bump("anim", `${a.animationName ?? a.transitionProperty ?? "?"} ${t?.tagName?.toLowerCase()}.${String(t?.className?.baseVal ?? t?.className ?? "").split(" ").slice(0, 3).join(".")} ${a.playState}`);
    }
  }, 1000);
  window.__counts = counts;
});
await new Promise((r) => setTimeout(r, seconds * 1000));
const counts = await page.evaluate(() => window.__counts);
for (const [bucket, table] of Object.entries(counts)) {
  console.log(`== ${bucket}`);
  for (const [key, n] of Object.entries(table).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(String(bucket === "anim" ? n : Math.round((n / seconds) * 10) / 10).padStart(7), key.slice(0, 200));
  }
}
await browser.close();

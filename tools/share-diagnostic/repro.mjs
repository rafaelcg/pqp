#!/usr/bin/env node
// One-command repro of the high-refresh game share stall (2026-09-30).
//
//   pnpm install            (once, for Playwright)
//   node tools/share-diagnostic/repro.mjs
//
// It opens two browsers on this machine:
//   - the "game": client/public/share-diagnostic-game.html in Playwright's
//     Chromium, a full-window shader drawn on every display refresh, at a
//     load you pick, optionally capped at 60;
//   - the "presenter": client/public/share-diagnostic.html in Google Chrome,
//     which captures the game's WINDOW through the real OS capturer
//     (ScreenCaptureKit on macOS, Windows Graphics Capture on Windows) and
//     encodes it the way a pqp share does (H.264 as the media server
//     negotiates it, three layers, maintain-framerate, contentHint motion).
//
// Google Chrome needs screen recording permission (macOS: System Settings,
// Privacy and Security, Screen and System Audio Recording, Google Chrome).
// Nothing leaves the machine. Prints one line per condition and a verdict.
//
// Options (env): SECONDS=20, ONLY=1,3 (run those rows), GAME_CHANNEL=chrome.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const publicDir = path.join(root, "client/public");
const require = createRequire(path.join(root, "client/package.json"));
const { chromium } = require("@playwright/test");

const SECONDS = Number(process.env.SECONDS || 20);
const ONLY = process.env.ONLY ? process.env.ONLY.split(",").map(Number) : null;

// load: light (the display's refresh with an idle graphics card), heavy
// (every refresh, graphics card busy), extreme (graphics card cannot keep up).
const CONDITIONS = [
  { load: "light", cap: false, fps: 60, what: "game light, capture 60 (baseline)" },
  { load: "heavy", cap: false, fps: 60, what: "game heavy uncapped, capture 60 (pqp today)" },
  { load: "heavy", cap: true, fps: 60, what: "game heavy capped at 60, capture 60" },
  { load: "heavy", cap: false, fps: 30, what: "game heavy uncapped, capture 30" },
  { load: "extreme", cap: false, fps: 60, what: "game extreme, capture 60 (pqp today)" },
  { load: "extreme", cap: false, fps: 30, what: "game extreme, capture 30" },
];

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = path.join(publicDir, path.normalize(url.pathname).replace(/^([/\\])+/, ""));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://localhost:${server.address().port}`;

function gpuBusy() {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], { encoding: "utf8" });
    const m = out.match(/"Device Utilization %"=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const f = (v, d = 0) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));

const results = [];
try {
  for (const [i, c] of CONDITIONS.entries()) {
    const n = i + 1;
    if (ONLY && !ONLY.includes(n)) continue;
    const game = await chromium.launch({
      headless: false,
      channel: process.env.GAME_CHANNEL || undefined,
      args: ["--window-position=560,0", "--window-size=1500,980", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
    });
    const gamePage = await game.newPage({ viewport: null });
    await gamePage.goto(`${base}/share-diagnostic-game.html?load=${c.load}${c.cap ? "&cap=60" : ""}`);
    await gamePage.bringToFront();
    await gamePage.waitForTimeout(2500);
    const presenter = await chromium.launch({
      headless: false,
      channel: "chrome",
      args: [
        "--auto-select-desktop-capture-source=pqp stand-in game",
        "--window-position=0,0",
        "--window-size=560,980",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
      ],
    });
    const page = await presenter.newPage({ viewport: null });
    await page.goto(`${base}/share-diagnostic.html?auto=1&surface=window&fps=${c.fps}&seconds=${SECONDS}`);
    const gpu = [];
    const gameFps = [];
    const deadline = Date.now() + (SECONDS + 10) * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      gpu.push(gpuBusy());
      gameFps.push(await gamePage.evaluate(() => window.__gameFps).catch(() => null));
      if (await page.evaluate(() => Boolean(window.__shareDiagnostic)).catch(() => false)) break;
    }
    const report = await page.evaluate(() => window.__shareDiagnostic).catch(() => null);
    await presenter.close();
    await game.close();
    // The first seconds are the bandwidth estimate and the encoder warming up.
    const rows = (report?.rows || []).slice(3);
    const r = {
      n,
      what: c.what,
      gameFps: mean(gameFps),
      gpu: mean(gpu),
      asked: c.fps,
      captured: mean(rows.map((x) => x.captured)),
      sent: mean(rows.map((x) => x.sentFps)),
      encMs: mean(rows.map((x) => x.encMs)),
      cpuShare: rows.length ? rows.filter((x) => x.limitedBy === "cpu").length / rows.length : null,
      height: mean(rows.map((x) => x.height)),
      recv: mean(rows.map((x) => x.recvFps)),
      freezes: rows.reduce((a, x) => a + (x.freezes || 0), 0),
      encoder: report?.env?.encoder,
      error: report ? null : "no report (did Chrome get screen recording permission?)",
    };
    results.push(r);
    console.log(
      `${n}. ${r.what}\n   game ${f(r.gameFps)} fps, graphics card ${r.gpu === null ? "?" : f(r.gpu) + "%"} busy | ` +
        `captured ${f(r.captured)} of ${r.asked}, sent ${f(r.sent)}, encode ${f(r.encMs, 1)} ms/frame (budget ${f(1000 / r.asked, 1)}), ` +
        `limited by cpu ${f((r.cpuShare ?? 0) * 100)}% of the time, sent ${f(r.height)} lines, viewer ${f(r.recv)} fps, ${r.freezes} freezes` +
        (r.encoder ? ` [${r.encoder}]` : "") +
        (r.error ? `\n   ${r.error}` : ""),
    );
  }
} finally {
  server.close();
}

const byN = Object.fromEntries(results.map((r) => [r.n, r]));
const over = (r) => r && r.encMs !== null && r.encMs > (1000 / r.asked) * 0.9;
console.log("\nVerdict:");
if (byN[1] && byN[2] && byN[1].encMs !== null && byN[2].encMs !== null) {
  const ratio = byN[2].encMs / Math.max(0.1, byN[1].encMs);
  console.log(
    `- A busy graphics card made every shared frame ${f(ratio, 1)}x as expensive (${f(byN[1].encMs, 1)} -> ${f(byN[2].encMs, 1)} ms), with the game still at full speed.`,
  );
}
for (const [heavy, capped] of [
  [2, 4],
  [5, 6],
]) {
  const a = byN[heavy];
  const b = byN[capped];
  if (!a || !b) continue;
  if (over(a) || (a.cpuShare ?? 0) > 0.2) {
    console.log(
      `- At 60 fps the share fell behind (${f(a.encMs, 1)} ms per frame against a ${f(1000 / a.asked, 1)} ms budget, cpu-limited ${f((a.cpuShare ?? 0) * 100)}% of the time, ${f(a.height)} lines sent). ` +
        `At 30 fps: ${f(b.encMs, 1)} ms against ${f(1000 / b.asked, 1)} ms, ${f(b.height)} lines, cpu-limited ${f((b.cpuShare ?? 0) * 100)}%.`,
    );
  } else {
    console.log(`- Row ${heavy}: the share kept up at 60 fps on this machine (${f(a.encMs, 1)} ms per frame).`);
  }
}
console.log(
  "- On Windows the same cost lands earlier, in the capture itself (a blocking copy of each frame off the graphics card), and Chromium then lowers the capture rate to keep that copy under half a core. That part cannot happen on a Mac, so a Mac shows the cost growing but rarely the full freeze.",
);

#!/usr/bin/env node
// Drives stock hls.js against the harness's playlist server (server.mjs)
// in real Google Chrome via Playwright, for a fixed window, then computes
// a PASS/FAIL verdict and dumps everything that went into it. Reused
// verbatim from the scratchpad repro session that first reproduced the
// production symptom locally, plus a verdict computation run.sh can parse
// (VERDICT: PASS|FAIL on its own line, exit code 0/1) and dynamic
// resolution of playwright-core/hls.js so this does not silently break on
// the next `pnpm install`.
//
// Usage: node run.mjs [cfg] [seconds]
//   cfg     "default" or "client" (see page.html's cfgs) -- default "default"
//   seconds how long to watch -- default 60 (docs/plans/LL_HLS.md's whole
//           point is ~2-4s to the live edge; 60s is long enough to judge
//           "reached AND HELD it", not just an initial buffer fill)
import { readFileSync } from "node:fs";
import http from "node:http";
import { resolvePlaywrightCore, resolveHlsJsDist } from "./env.mjs";

// playwright-core is CommonJS; dynamic import() of it in Node only
// reliably exposes `default` (the interop's named-export detection is not
// guaranteed for every CJS shape), unlike a static `import pw from ...`
// which Node's loader resolves the same way but destructures more
// forgivingly. Cover both so this keeps working regardless.
const pwMod = await import(resolvePlaywrightCore());
const { chromium } = pwMod.default ?? pwMod;
const HLS_JS_PATH = resolveHlsJsDist();

const cfg = process.argv[2] || "default";
const secs = Number(process.argv[3] || 60);
const upstreamPort = Number(process.env.LL_HARNESS_PORT || 18080);
const proxyPort = Number(process.env.PORT || 18081);
const pageHtmlPath = new URL("./page.html", import.meta.url);

// NET_PROFILE=name:minMs:maxMs:spikePct:spikeMs delays every media and
// playlist response by a uniform minMs..maxMs, plus spikeMs on spikePct% of
// them: a viewer's network, the shape the 2026-09-21 investigation's lab
// used (br:60:250:1:900, mobile:100:400:3:1500). Unset is no delay.
const profile = (() => {
  const v = process.env.NET_PROFILE;
  if (!v) return null;
  const [name, a, b, sp, sm] = v.split(":");
  return { name, a: +a, b: +b, sp: +sp, sm: +sm };
})();
const netDelay = () => (profile ? profile.a + Math.random() * (profile.b - profile.a) + (Math.random() * 100 < profile.sp ? profile.sm : 0) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proxy = http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/hls.js")) {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(readFileSync(HLS_JS_PATH));
    }
    if (req.url.startsWith("/page")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(readFileSync(pageHtmlPath));
    }
    const d = netDelay();
    await sleep(d / 2);
    const r = await fetch(`http://127.0.0.1:${upstreamPort}${req.url}`);
    const b = Buffer.from(await r.arrayBuffer());
    await sleep(d / 2);
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/octet-stream" });
    res.end(b);
  })
  .listen(proxyPort);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (/hls|error|Error/i.test(t)) console.log("CONSOLE", t.slice(0, 220));
});
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${proxyPort}/page?cfg=${cfg}`);
await page.waitForTimeout(secs * 1000);
const L = await page.evaluate(() => window.__L || []);
const F = await page.evaluate(() => {
  if (window.__closeFreeze) window.__closeFreeze();
  return window.__F || null;
});
await browser.close();
proxy.close();

const t0 = L.length ? L[0].t : 0;
const errs = L.filter((x) => x.k === "ERROR");
console.log(`=== cfg=${cfg} secs=${secs} events=${L.length} errors=${errs.length}`);
const byErr = {};
for (const e of errs) {
  const k = e.o.type + "/" + e.o.details + (e.o.fatal ? "/FATAL" : "");
  byErr[k] = (byErr[k] || 0) + 1;
}
console.log("ERROR SUMMARY:", JSON.stringify(byErr, null, 1));
for (const e of errs.slice(0, 14)) console.log(((e.t - t0) / 1000).toFixed(1) + "s ERROR", JSON.stringify(e.o));
const lv = L.filter((x) => x.k === "LEVEL_UPDATED");
if (lv.length) {
  console.log("LEVEL first:", JSON.stringify(lv[0].o));
  console.log("LEVEL last:", JSON.stringify(lv.at(-1).o));
}
console.log("MANIFEST:", JSON.stringify(L.find((x) => x.k === "MANIFEST_PARSED")?.o), "CODECS:", JSON.stringify(L.find((x) => x.k === "BUFFER_CODECS")?.o));
const ticks = L.filter((x) => x.k === "tick");
for (const t of ticks.filter((_, i) => i % 3 === 0).slice(0, 14)) console.log(((t.t - t0) / 1000).toFixed(0) + "s tick", JSON.stringify(t.o));
const vids = L.filter((x) => x.k.startsWith("video:"));
for (const v of vids.slice(0, 16)) console.log(((v.t - t0) / 1000).toFixed(1) + "s " + v.k, JSON.stringify(v.o));
// Every time the element ran out of media: a "waiting" event, and how long
// until the next "playing". This is what a viewer calls a stall.
{
  // Anything before the first "playing" is the startup buffer fill, not a
  // stall, so only waits that begin after it count.
  const firstPlay = L.find((x) => x.k === "video:playing")?.t ?? Infinity;
  let stalls = 0;
  let stalledMs = 0;
  let open = null;
  for (const x of L) {
    if (x.t <= firstPlay) continue;
    if (x.k === "video:waiting" && open == null) {
      open = x.t;
      stalls++;
    } else if (x.k === "video:playing" && open != null) {
      stalledMs += x.t - open;
      open = null;
    }
  }
  if (open != null) stalledMs += L.at(-1).t - open;
  const fz = F ? ` freezes=${F.episodes} frozenMs=${F.frozenMs} longestFreezeMs=${F.longestMs}` : "";
  const playedMin = Math.max(1e-9, (L.at(-1).t - firstPlay) / 60000);
  const perMin = Number.isFinite(firstPlay) ? (stalls / playedMin).toFixed(1) : "n/a";
  console.log(`WAITING: stalls=${stalls} stallsPerMin=${perMin} stalledMs=${stalledMs}${fz}${profile ? ` profile=${profile.name}` : ""}`);
  const lat = L.filter((x) => x.k === "tick" && x.o.latency && Number(x.o.ct) > 0).map((x) => Number(x.o.latency));
  if (lat.length) console.log(`LIVE LATENCY: last=${lat.at(-1).toFixed(2)}s max=${Math.max(...lat).toFixed(2)}s`);
}
const fb = L.filter((x) => x.k === "FRAG_BUFFERED");
console.log("frags buffered:", fb.length, "first", JSON.stringify(fb[0]?.o), "last", JSON.stringify(fb.at(-1)?.o));
const ve = L.find((x) => x.k === "video:error");
if (ve) {
  console.log("--- 6s before the video error:");
  for (const x of L.filter((x) => x.t >= ve.t - 6000 && x.t <= ve.t + 500 && x.k !== "tick")) {
    console.log(((x.t - t0) / 1000).toFixed(2) + "s", x.k, JSON.stringify(x.o).slice(0, 200));
  }
}

// --- Verdict ---------------------------------------------------------
// PASS = no MEDIA_ERR_DECODE anywhere AND the viewer reached and HELD the
// live edge (currentTime kept advancing through the tail of the window,
// not just an initial buffer fill that then froze).
// FAIL = a decode death (MediaError.MEDIA_ERR_DECODE === 3, the Chrome
// MEDIA_ERR_DECODE / VideoToolbox -12909 symptom docs/plans/LL_HLS.md and
// this harness both exist to reproduce) or the video element never
// reached "playing" at all.
const decodeDeath =
  errs.some((e) => typeof e.o.mediaErr === "string" && e.o.mediaErr.startsWith("3:")) ||
  vids.some((v) => v.k === "video:error" && v.o.err === 3);
const everPlayed = vids.some((v) => v.k === "video:playing");
const tailTicks = ticks.slice(-4); // last ~8s of the window
const tailAdvanced = tailTicks.length >= 2 && Number(tailTicks.at(-1).o.ct) > Number(tailTicks[0].o.ct);
const tailReady = tailTicks.length > 0 && tailTicks.every((t) => Number(t.o.ready) >= 3);
const heldLiveEdge = everPlayed && tailAdvanced && tailReady;

let verdict, reason;
if (decodeDeath) {
  verdict = "FAIL";
  reason = "decode-death";
} else if (!everPlayed) {
  verdict = "FAIL";
  reason = "never-played";
} else if (!heldLiveEdge) {
  verdict = "FAIL";
  reason = "stalled-before-edge-held";
} else {
  verdict = "PASS";
  reason = "reached-and-held-live-edge";
}
console.log(`VERDICT: ${verdict} (${reason})`);
process.exit(verdict === "PASS" ? 0 : 1);

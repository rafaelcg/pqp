// Local first-frame bench for a watch party viewer. See README.md.
//
//   node tools/party-first-frame-bench/bench.mjs
//
// Needs: a local API (dev auth bypass, TEMPORARY database), a production
// build of the client served with compression, ffmpeg. The HLS origin is a
// local mock with generated media, so the numbers are MODELLED by the CDP
// throttle profile below, not measured against a real egress.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { brotliCompressSync } from "node:zlib";
import { extname, join } from "node:path";

const require = createRequire(new URL("../../client/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const API = process.env.API_URL ?? "http://localhost:3151";
const DIST = process.env.DIST ?? "";
const APP_PORT = Number(process.env.APP_PORT ?? 5290);
const MEDIA_PORT = Number(process.env.MEDIA_PORT ?? 4599);
const MEDIA_DIR = process.env.MEDIA_DIR ?? "/tmp/pqp-first-frame-media";
const RUNS = Number(process.env.RUNS ?? 3);
const LADDER = (process.env.LADDER ?? "three").split(",");
const PROFILES = {
  wifi: { latency: 20, down: 50_000_000 },
  "4g": { latency: 60, down: 8_000_000 },
  "3g-fast": { latency: 150, down: 1_600_000 },
};
const ONLY_PROFILES = (process.env.PROFILES ?? "wifi,4g,3g-fast").split(",");
const SERVICE_WORKERS = process.env.SERVICE_WORKERS ?? "block";
const DEV_TOKEN = "dev-local-token";
// Ablations. RELOAD=1: reload once after the app is ready so a service worker
// (SERVICE_WORKERS=allow) controls the page, as it does for anybody who has
// been through a sign-up redirect. BLOCK_FILM=1: abort the bubbles film in the
// flag-OFF runs, to see how much of the wait the film alone is.
const RELOAD = process.env.RELOAD === "1";
const BLOCK_FILM = process.env.BLOCK_FILM === "1";

// ---------------------------------------------------------------- media
const RUNGS = [
  { name: "720p", size: "1280x720", kbps: 3000, bw: 3_200_000, res: "1280x720" },
  { name: "480p", size: "854x480", kbps: 900, bw: 1_000_000, res: "854x480" },
  { name: "360p", size: "640x360", kbps: 500, bw: 600_000, res: "640x360" },
];
function ensureMedia() {
  mkdirSync(MEDIA_DIR, { recursive: true });
  for (const r of RUNGS) {
    if (existsSync(join(MEDIA_DIR, `${r.name}-6.ts`))) continue;
    const out = spawnSync(
      "ffmpeg",
      [
        "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `testsrc2=size=${r.size}:rate=30`,
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "32", "-c:v", "libx264", "-preset", "veryfast",
        "-b:v", `${r.kbps}k`, "-maxrate", `${r.kbps}k`, "-bufsize", `${r.kbps}k`,
        "-g", "120", "-keyint_min", "120", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
        "-hls_segment_filename", join(MEDIA_DIR, `${r.name}-%d.ts`),
        join(MEDIA_DIR, `${r.name}.m3u8`),
      ],
      { stdio: "inherit" },
    );
    if (out.status !== 0) throw new Error("ffmpeg failed");
  }
}

/** Mock HLS origin: a master, a live-looking media playlist per rung, segments. */
function startMediaServer(log, ladderName) {
  const rungs = ladderName === "single" ? [RUNGS[0]] : RUNGS;
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${MEDIA_PORT}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Headers": "*" });
      return res.end();
    }
    log.push({ t: Date.now(), path: url.pathname });
    if (url.pathname === "/master.m3u8") {
      const body = [
        "#EXTM3U",
        ...rungs.flatMap((r) => [
          `#EXT-X-STREAM-INF:BANDWIDTH=${r.bw},RESOLUTION=${r.res},FRAME-RATE=30`,
          `${r.name}.m3u8?t=${url.searchParams.get("t") ?? ""}`,
        ]),
        "",
      ].join("\n");
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      return res.end(body);
    }
    const playlist = url.pathname.match(/^\/(\d+p)\.m3u8$/);
    if (playlist) {
      const lines = readFileSync(join(MEDIA_DIR, `${playlist[1]}.m3u8`), "utf8")
        .split("\n")
        .filter((l) => !l.startsWith("#EXT-X-ENDLIST") && !l.startsWith("#EXT-X-PLAYLIST-TYPE"));
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      return res.end(lines.join("\n"));
    }
    const seg = url.pathname.slice(1);
    const file = join(MEDIA_DIR, seg);
    if (/^\d+p-\d+\.ts$/.test(seg) && existsSync(file)) {
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": statSync(file).size });
      return createReadStream(file).pipe(res);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(MEDIA_PORT, () => resolve(server)));
}

// ------------------------------------------------------------ static app
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webm": "video/webm", ".mp4": "video/mp4",
  ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
};
function startAppServer() {
  const cache = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = join(DIST, decodeURIComponent(url.pathname));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const compressible = /^(text|application\/(json|javascript))|javascript|svg/.test(type);
    const headers = { "Content-Type": type };
    if (/\/assets\//.test(url.pathname)) headers["Cache-Control"] = "public, max-age=31536000, immutable";
    if (compressible && /\bbr\b/.test(req.headers["accept-encoding"] ?? "")) {
      if (!cache.has(file)) cache.set(file, brotliCompressSync(readFileSync(file)));
      const body = cache.get(file);
      res.writeHead(200, { ...headers, "Content-Encoding": "br", "Content-Length": body.length });
      return res.end(body);
    }
    const size = statSync(file).size;
    // Range requests, so the film's <video> behaves as behind a real CDN.
    res.writeHead(200, { ...headers, "Content-Length": size });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(APP_PORT, () => resolve(server)));
}

// -------------------------------------------------------------- accounts
const hdr = (s) => ({ "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}:${s}` });
async function materialise(s) {
  const me = await (await fetch(`${API}/api/me`, { headers: hdr(s) })).json();
  if (me.ageGate && me.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, { method: "POST", headers: hdr(s), body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH", headers: hdr(s),
    body: JSON.stringify({ onboardedAt: new Date().toISOString(), firstRunDismissedAt: new Date().toISOString() }),
  });
}
async function seedParty() {
  const stamp = Date.now().toString(36);
  const owner = `ffo${stamp}`;
  await materialise(owner);
  const { server } = await (await fetch(`${API}/api/servers`, { method: "POST", headers: hdr(owner), body: JSON.stringify({ name: `Bench ${stamp}` }) })).json();
  const { party } = await (await fetch(`${API}/api/servers/${server.id}/watch-parties`, { method: "POST", headers: hdr(owner), body: JSON.stringify({ name: "Filme" }) })).json();
  const live = await fetch(`${API}/api/watch-parties/${party.id}/state`, { method: "POST", headers: hdr(owner), body: JSON.stringify({ state: "live" }) });
  if (!live.ok) throw new Error(`go live: ${live.status}`);
  return { owner, serverId: server.id, channelId: party.channelId };
}
async function newViewer(serverId, owner, n) {
  const s = `ffv${Date.now().toString(36)}${n}`;
  await materialise(s);
  const { invite } = await (await fetch(`${API}/api/servers/${serverId}/invites`, { method: "POST", headers: hdr(owner), body: "{}" })).json();
  const joined = await fetch(`${API}/api/invites/${invite.code}/join`, { method: "POST", headers: hdr(s) });
  if (!joined.ok) throw new Error(`join: ${joined.status}`);
  return s;
}

// ------------------------------------------------------------------ run
async function measure(browser, ctx, { flag, profile, viewer, stream }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    serviceWorkers: SERVICE_WORKERS === "block" ? "block" : "allow",
  });
  const page = await context.newPage();
  const requests = [];
  page.on("requestfinished", async (r) => {
    const u = r.url();
    if (/hls-.*\.js|bubbles-loop|\.ts$|\.m3u8|master/.test(u)) {
      requests.push({ url: u.replace(/\?.*/, "").split("/").slice(-2).join("/"), end: Date.now() });
    }
  });
  if (BLOCK_FILM && !flag) {
    await page.route("**/bubbles-loop.*", (route) => route.abort());
  }
  await page.route("**/api/live-hls/config*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, enabled: true, fastStart: flag } });
  });
  await page.route(`**/api/channels/${ctx.channelId}/live`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, stream } });
  });
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === "string") {
        try {
          const f = JSON.parse(m);
          if (f.type === "channel-live" && f.channelId === ctx.channelId) {
            ws.send(JSON.stringify({ ...f, stream }));
            return;
          }
        } catch { /* not ours */ }
      }
      ws.send(m);
    });
  });
  await page.addInitScript((v) => {
    localStorage.setItem("pqp:dev-user-suffix", v);
    localStorage.setItem("pqp:watch-party-channels", "1");
  }, viewer);
  // The app on a channel that is NOT the party, unthrottled, as a newcomer
  // who has been through onboarding already has it. Then the link is on.
  await page.goto(`http://localhost:${APP_PORT}/app?lang=en&watchParty=1`);
  await page.getByPlaceholder(/^Message /).waitFor({ timeout: 30_000 });
  if (RELOAD) {
    await page.waitForTimeout(4000);
    await page.reload();
    await page.getByPlaceholder(/^Message /).waitFor({ timeout: 30_000 });
  }
  // Let the app's own first-load work (server config, idle callbacks) settle.
  await page.waitForTimeout(2500);
  const cdp = await context.newCDPSession(page);
  const p = PROFILES[profile];
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: p.latency, downloadThroughput: p.down / 8, uploadThroughput: p.down / 8,
  });
  const row = page.locator(`a[href*="/channel/${ctx.channelId}"], [data-channel-id="${ctx.channelId}"]`).first();
  const t0 = Date.now();
  await row.click();
  const seen = { caption: null, film: false };
  const deadline = t0 + 90_000;
  let first = null;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const v = [...document.querySelectorAll("video")].find((el) => !el.hasAttribute("data-decorative"));
      const shade = document.querySelector('[data-testid="hls-buffering"], [data-testid="hls-reconnecting"]');
      return {
        playing: !!v && v.currentTime > 0.05 && !v.paused && v.readyState >= 2,
        text: shade ? shade.textContent : null,
        film: !!document.querySelector("video[data-decorative]"),
      };
    });
    if (state.text && !seen.caption) seen.caption = state.text;
    if (state.film) seen.film = true;
    if (state.playing) { first = Date.now() - t0; break; }
    await page.waitForTimeout(40);
  }
  const rel = requests.map((r) => ({ url: r.url, at: r.end - t0 })).sort((a, b) => a.at - b.at);
  await context.close();
  return { first, caption: seen.caption, film: seen.film, requests: rel };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function main() {
  if (!DIST) throw new Error("set DIST to a production build of the client");
  ensureMedia();
  const ctx = await seedParty();
  const appServer = await startAppServer();
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const results = [];
  try {
    for (const ladder of LADDER) {
      const log = [];
      const media = await startMediaServer(log, ladder);
      const stream = {
        hlsUrl: `http://localhost:${MEDIA_PORT}/master.m3u8?t=bench`,
        startedAt: Date.now() - 60_000,
        presenterPeerId: "bench-presenter",
        delaySeconds: 8,
      };
      for (const profile of ONLY_PROFILES) {
        for (const flag of [false, true]) {
          const runs = [];
          for (let i = 0; i < RUNS; i += 1) {
            const viewer = await newViewer(ctx.serverId, ctx.owner, `${ladder}${profile}${flag}${i}`);
            runs.push(await measure(browser, ctx, { flag, profile, viewer, stream }));
          }
          const firsts = runs.map((r) => r.first).filter((x) => x !== null);
          results.push({ ladder, profile, flag, median: median(firsts), all: runs.map((r) => r.first), caption: runs[0].caption, film: runs[0].film, sample: runs[0].requests.slice(0, 8) });
          console.log(JSON.stringify(results.at(-1)));
        }
      }
      media.close();
    }
  } finally {
    await browser.close();
    appServer.close();
  }
  console.log("\nladder  profile  flag   median ms   runs");
  for (const r of results) console.log(`${r.ladder.padEnd(7)} ${r.profile.padEnd(8)} ${String(r.flag).padEnd(6)} ${String(r.median).padStart(8)}   ${r.all.join(", ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

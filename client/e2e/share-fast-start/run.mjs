#!/usr/bin/env node
/**
 * One scenario of the share fast-start rig, by hand:
 *
 *   node e2e/share-fast-start/run.mjs [--viewers 1] [--fill 0] [--shape 5mbit]
 *     [--fast 0|1] [--warm 20] [--watch 60] [--stage 1280x720] [--together 0|1]
 *     [--late-viewers 0] [--out results/x.json]
 *
 * --viewers   measured viewers (real Chrome pages, the product's session)
 * --fill      extra subscribers from `lk load-test` so the room is the size
 *             of a film night (the presenter's plan caps the top layer at
 *             720p above LARGE_ROOM_PARTICIPANTS = 20)
 * --shape     cap the FIRST viewer's downlink (it joins through TURN)
 * --fast      the `share_fast_start_quality` flag in the viewers
 * --warm      seconds the share runs before the viewers join (0 with
 *             --together 1 is "everybody arrives as the film starts")
 * --watch     seconds each viewer is sampled
 * --idle      participants that join and neither publish nor subscribe
 *             (`lk room join`): a room of film-night size for the
 *             presenter's plan at almost no CPU, unlike --fill
 * --grow      more `lk load-test` subscribers that arrive --grow-after
 *             seconds after the viewers did (a room growing past 20 while
 *             the film is on)
 * --shape-presenter  cap the presenter's uplink (it joins through TURN)
 *
 * Needs Docker, ffmpeg, Google Chrome, and the client's Vite on BASE
 * (default http://localhost:5299; started here when nothing answers).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  ensureMedia,
  harnessUrl,
  sfuLogs,
  shape,
  shapeStats,
  startSfu,
  stopSfu,
  summarise,
  token,
} from "./rig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, "../..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Every option at its default, with `overrides` laid over. For the spec. */
export function scenario(overrides = {}) {
  return {
    viewers: 1, fill: 0, idle: 0, shape: "", fast: false, warm: 20, watch: 60,
    stage: "1280x720", together: false, out: "", keepSfu: false, grow: 0,
    growAfter: 20, shapePresenter: "", src: "", impair: "",
    base: process.env.BASE ?? "http://localhost:5299",
    ...overrides,
  };
}

const opts = {
  viewers: Number(arg("viewers", "1")),
  fill: Number(arg("fill", "0")),
  idle: Number(arg("idle", "0")),
  shape: arg("shape", ""),
  fast: arg("fast", "0") === "1",
  warm: Number(arg("warm", "20")),
  watch: Number(arg("watch", "60")),
  stage: arg("stage", "1280x720"),
  together: arg("together", "0") === "1",
  out: arg("out", ""),
  base: process.env.BASE ?? "http://localhost:5299",
  keepSfu: arg("keep-sfu", "0") === "1",
  grow: Number(arg("grow", "0")),
  growAfter: Number(arg("grow-after", "20")),
  shapePresenter: arg("shape-presenter", ""),
  src: arg("src", ""),
  impair: arg("impair", "").replace(/_/g, " "), // netem words, "_" for spaces
};

async function reachable(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureVite() {
  if (await reachable(`${opts.base}/e2e/share-fast-start/harness.html`)) return null;
  const port = new URL(opts.base).port;
  const child = spawn("pnpm", ["exec", "vite", "--port", port, "--strictPort"], {
    cwd: CLIENT,
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    if (await reachable(`${opts.base}/e2e/share-fast-start/harness.html`)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("vite did not come up");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(page) {
  for (let i = 0; i < 120; i++) {
    const state = await page.evaluate(() => ({ ready: window.__sfs?.ready, error: window.__sfs?.error }));
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await sleep(250);
  }
  throw new Error("page never became ready");
}

/**
 * Open a rig page and wait until it has joined. Through the shaped TURN relay
 * on Docker Desktop the first ICE attempt sometimes fails outright ("could not
 * establish pc connection", about one run in three); that is the rig's relay,
 * not the product, so the page is simply opened again. Attempts are recorded.
 */
async function openJoined(page, url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    await page.goto(url);
    try {
      await waitReady(page);
      return i;
    } catch (err) {
      if (i === attempts) throw err;
    }
  }
  return attempts;
}

export async function runScenario(o = opts) {
  ensureMedia();
  const vite = await ensureVite();
  startSfu();
  await sleep(2500);
  const since = Math.floor(Date.now() / 1000) - 1;
  const room = `sfs-${Date.now()}`;
  const launch = () =>
    chromium.launch({
      channel: "chrome",
      headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        // `src=display`: Chrome's fake display device answers getDisplayMedia.
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--auto-select-desktop-capture-source=Entire screen",
      ],
    });
  const presenterBrowser = await launch();
  const viewerBrowser = await launch();
  let filler = null;
  let grower = null;
  const idlers = [];
  const loadTest = (count) =>
    spawn(
      "lk",
      [
        "load-test", "--url", "ws://127.0.0.1:7880",
        "--api-key", "sfsdevkey", "--api-secret", "sfs-local-secret-not-a-real-key-0123456789",
        "--room", room, "--subscribers", String(count), "--duration", "4m",
      ],
      { stdio: "ignore" },
    );
  const result = { opts: o, room, viewers: [], presenter: null };
  try {
    if (o.shape || o.shapePresenter) {
      shape({
        viewer: o.shape ? { rate: o.shape, impair: o.impair || undefined } : undefined,
        presenter: o.shapePresenter ? { rate: o.shapePresenter, impair: "delay 15ms", queueMs: 300 } : undefined,
      });
    }
    if (o.fill > 0) {
      filler = loadTest(o.fill);
      await sleep(4000);
    }
    for (let i = 0; i < o.idle; i++) {
      idlers.push(
        spawn(
          "lk",
          [
            "room", "join", "--url", "ws://127.0.0.1:7880",
            "--api-key", "sfsdevkey", "--api-secret", "sfs-local-secret-not-a-real-key-0123456789",
            "--identity", `idle-${i}`, room,
          ],
          { stdio: "ignore" },
        ),
      );
    }
    if (o.idle > 0) await sleep(3000);
    const presenter = await (await presenterBrowser.newContext()).newPage();
    if (process.env.DEBUG) {
      presenter.on("console", (m) => console.log("[presenter]", m.text()));
      presenter.on("pageerror", (e) => console.log("[presenter error]", e.message));
    }
    const viewerPages = [];
    const openViewer = async (index) => {
      const context = await viewerBrowser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      page.attempts = await openJoined(
        page,
        harnessUrl(o.base, {
          role: "viewer",
          room,
          identity: `viewer-${index}`,
          token: token(room, `viewer-${index}`),
          stage: o.stage,
          relay: o.shape && index === 0 ? "1" : "0",
          fast: o.fast ? "1" : "0",
        }),
      );
      viewerPages.push(page);
      return page;
    };
    if (o.together) {
      await Promise.all(Array.from({ length: o.viewers }, (_, i) => openViewer(i)));
    }
    result.presenterAttempts = await openJoined(
      presenter,
      harnessUrl(o.base, {
        role: "presenter",
        room,
        identity: "presenter",
        token: token(room, "presenter"),
        relay: o.shapePresenter ? "1" : "0",
        fast: o.fast ? "1" : "0",
        ...(o.src ? { src: o.src } : {}),
      }),
    );
    if (!o.together) {
      await sleep(o.warm * 1000);
      await Promise.all(Array.from({ length: o.viewers }, (_, i) => openViewer(i)));
    }
    const joinedAt = Date.now();
    if (o.grow > 0) {
      await sleep(o.growAfter * 1000);
      grower = loadTest(o.grow);
      result.grewAtMs = Date.now() - joinedAt;
    }
    await sleep(Math.max(0, o.watch * 1000 - (Date.now() - joinedAt)));
    for (const page of viewerPages) {
      const sfs = await page.evaluate(() => window.__sfs);
      result.viewers.push({ summary: summarise(sfs, 0), attempts: page.attempts, raw: sfs });
    }
    result.presenter = await presenter.evaluate(() => window.__sfs);
    if (o.shape || o.shapePresenter) result.shaper = shapeStats();
  } finally {
    filler?.kill();
    grower?.kill();
    for (const p of idlers) p.kill();
    await presenterBrowser.close();
    await viewerBrowser.close();
    result.sfuLog = sfuLogs(since).filter((l) =>
      /allocat|probe|layer|quality|keyframe|PLI|stream state|congest|deficient|bandwidth|estimate/i.test(l.msg ?? ""),
    );
    if (!o.keepSfu) stopSfu();
    if (vite) vite.kill();
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await runScenario();
  const out = opts.out || path.join(HERE, "results", `run-${Date.now()}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  for (const [i, v] of result.viewers.entries()) {
    const s = v.summary;
    console.log(
      `viewer ${i}: connected ${s.connected} subscribed ${s.subscribed} first frame ${s.firstFrame} heights ${s.heights.map((h) => `${h.h}@${h.t}`).join(" ")} steady ${s.steadyKbps} kbps`,
    );
  }
  console.log(`wrote ${out}`);
  spawnSync("true");
}

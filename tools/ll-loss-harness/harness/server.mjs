#!/usr/bin/env node
// Renders the REAL edge-Worker LL-HLS playlist (buildLlRenditionPlaylist /
// buildLlMultivariantPlaylist / parseLlState, imported straight from
// tools/hls-edge/src -- not reimplemented) over the harness's own
// pqp-remuxd origin, and proxies its media. This is what a viewer's
// browser actually talks to in the harness: stands in for
// tools/hls-edge's Worker (§ "The edge Worker becomes the playlist
// front", docs/plans/LL_HLS.md) without needing Miniflare or a Cloudflare
// deploy for a local repro.
//
// Env:
//   SID                 required: the session id remux-ctl.mjs start printed
//   LL_HARNESS_ORIGIN   default http://127.0.0.1:8090 (remuxd's published port)
//   LL_HARNESS_PORT     default 18080 (this server's own port)
//   HOLD_PARTS          default 6 (matches LL_PART_HOLD_BACK_PARTS production default)
import http from "node:http";
import { loadHarnessEnv, assertLocalUrl, resolveLlPlaylistModule, resolveLlStateModule, resolveBlockingReloadModule } from "./env.mjs";

const { buildLlRenditionPlaylist, buildLlMultivariantPlaylist, applyLlRenditionToken } = await import(resolveLlPlaylistModule());
const { parseLlState, trackForRung } = await import(resolveLlStateModule());
const edgeHold = await import(resolveBlockingReloadModule());

const SID = process.env.SID;
if (!SID) {
  console.error("server.mjs: SID env var required (the session id remux-ctl.mjs start printed)");
  process.exit(2);
}
const ORIGIN = process.env.LL_HARNESS_ORIGIN || "http://127.0.0.1:8090";
assertLocalUrl(ORIGIN, "LL_HARNESS_ORIGIN");
const PORT = Number(process.env.LL_HARNESS_PORT || 18080);
const HOLD_PARTS = Number(process.env.HOLD_PARTS || 6);
const KEY = process.env.MEDIA_ORIGIN_KEY || loadHarnessEnv().MEDIA_ORIGIN_KEY;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function origin(path) {
  return fetch(`${ORIGIN}/s/${SID}/${path}`, { headers: { "X-Pqp-Origin-Key": KEY } });
}
async function state() {
  const r = await origin("state.json");
  if (!r.ok) throw new Error(`state ${r.status}`);
  const parsed = parseLlState(await r.json());
  if (!parsed) throw new Error("state failed validation");
  return parsed;
}

// hasPart / awaitPart give this stand-in origin genuine RFC 8216bis
// blocking-reload semantics (`_HLS_msn` / `_HLS_part`): hold the request
// until the requested part exists, instead of answering immediately with
// whatever is current. This is not cosmetic -- the playlist this server
// renders advertises CAN-BLOCK-RELOAD=YES (buildLlRenditionPlaylist's
// default), so hls.js sends those query params and PACES ITSELF assuming
// the response won't arrive until the part does; answering instantly
// instead just means hls.js re-polls on its own, much slower, timer and
// perpetually plays catch-up in bursts -- a stall this harness would be
// manufacturing itself, indistinguishable from the one packet loss is
// supposed to cause. tools/hls-edge/src/hls-blocking-reload.js is the
// real Worker's version of this same idea, built on Workers' Response
// object; this is the same contract on plain Node http.
const BLOCKING_RELOAD_MAX_WAIT_MS = 4000;
const BLOCKING_RELOAD_POLL_MS = 100;
// POLL_MODE=edge holds the way tools/hls-edge's Worker does instead: the
// origin is re-read once per PART-TARGET, backing off to once a second
// after VIDEO_RUNG_FAST_POLL_WINDOW_MS on the video rung, for up to
// VIDEO_RUNG_HOLD_BUDGET_MS (3 x PART-TARGET on audio). Those constants
// are imported from the Worker's own module, not copied. The default
// (100 ms, 4 s) is kinder than production, which hides part lateness a
// real viewer pays for.
const POLL_MODE = process.env.POLL_MODE || "fast";
function holdPlan(rung, partTargetSecs) {
  if (POLL_MODE !== "edge") return { budgetMs: BLOCKING_RELOAD_MAX_WAIT_MS, intervalMs: () => BLOCKING_RELOAD_POLL_MS };
  const baseMs = Math.max(20, Math.round((partTargetSecs || edgeHold.DEFAULT_PART_TARGET_SECONDS) * 1000));
  const video = rung === "ll";
  return {
    budgetMs: video ? edgeHold.VIDEO_RUNG_HOLD_BUDGET_MS : 3 * baseMs,
    intervalMs: (elapsed) => (video && elapsed >= edgeHold.VIDEO_RUNG_FAST_POLL_WINDOW_MS ? Math.max(baseMs, edgeHold.VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS) : baseMs),
  };
}
// Availability is decided by the Worker's OWN functions over the playlist
// text it would serve (parseLiveEdge + isMsnPartAvailable), not a local
// re-implementation. The local one this replaced treated a complete
// segment with fewer parts than the index asked for as "not yet", forever:
// hls.js asks for the next part of the open segment, the segment then
// closes early on a keyframe (elastic segments do that all the time with a
// slow source), and the hold ran to its budget while the player timed out
// (levelLoadTimeOut) on media that was already published.
function renderRendition(st, rung) {
  const track = trackForRung(st, rung);
  if (!track) return null;
  const text = buildLlRenditionPlaylist(st, track, rung, { basePath: "", partHoldBackParts: HOLD_PARTS });
  return applyLlRenditionToken(text, "x").replaceAll("?t=x", "");
}
function hasPart(st, rung, msn, part) {
  const text = renderRendition(st, rung);
  if (text == null) return false;
  return edgeHold.isMsnPartAvailable(edgeHold.parseLiveEdge(text), { msn, part });
}
async function awaitPart(rung, msn, part) {
  const started = Date.now();
  let st = await state();
  const plan = holdPlan(rung, st.partTargetMs / 1000);
  const deadline = started + plan.budgetMs;
  while (!hasPart(st, rung, msn, part) && Date.now() < deadline) {
    const wait = Math.min(plan.intervalMs(Date.now() - started), deadline - Date.now());
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
    st = await state();
  }
  return st;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/master.m3u8") {
      const st = await state();
      const text = buildLlMultivariantPlaylist(st, {
        basePath: "",
        token: "x",
        videoCodec: process.env.VCODEC || "avc1.640028",
        videoWidth: Number(process.env.VW || 1280),
        videoHeight: Number(process.env.VH || 720),
        audioCodec: "mp4a.40.2",
      }).replaceAll("?t=x", "");
      log("MASTER served");
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "access-control-allow-origin": "*" });
      return res.end(text);
    }
    if (p === "/ll" || p === "/ll-audio") {
      const rung = p.slice(1);
      const msn = url.searchParams.get("_HLS_msn");
      const part = url.searchParams.get("_HLS_part");
      const st = msn != null ? await awaitPart(rung, Number(msn), part != null ? Number(part) : undefined) : await state();
      const text = renderRendition(st, rung);
      if (text == null) {
        res.writeHead(404);
        return res.end("no track");
      }
      const track = trackForRung(st, rung);
      log(`PLAYLIST ${rung} msn=${msn} part=${part} -> segs=${track.segments.length} lastMsn=${track.segments.at(-1)?.msn}`);
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "access-control-allow-origin": "*", "cache-control": "no-store" });
      return res.end(text);
    }
    const m = p.match(/^\/(ll|ll-audio)\/(.+)$/);
    if (m) {
      const r = await origin(m[2]);
      const buf = Buffer.from(await r.arrayBuffer());
      log(`MEDIA ${m[2]} -> ${r.status} ${buf.length}B`);
      res.writeHead(r.status, { "content-type": "video/mp4", "access-control-allow-origin": "*" });
      return res.end(buf);
    }
    res.writeHead(404);
    res.end("no");
  } catch (e) {
    const notReady = /state (404|409|410)|not active|validation/.test(String(e));
    log(notReady ? "NOT-READY" : "ERR", p, String(e));
    res.writeHead(notReady ? 503 : 500, { "retry-after": "1" });
    res.end(String(e));
  }
});
server.listen(PORT, "127.0.0.1", () => log(`harness playlist server on http://127.0.0.1:${PORT}/master.m3u8 (origin=${ORIGIN} sid=${SID} holdParts=${HOLD_PARTS})`));

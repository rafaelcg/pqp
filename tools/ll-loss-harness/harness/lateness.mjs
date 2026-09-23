#!/usr/bin/env node
// Measures when pqp-remuxd PUBLISHES each part, against where that part
// ends on the media timeline: the lateness a blocking playlist reload (and
// so a player) waits out. Independent of the remux's own lateness counters
// (its stats line's late250/late500/lateMaxMs) on purpose: this reads only
// what a viewer can see, state.json and the part bytes.
//
// Polls state.json every POLL_MS, stamps the first instant each part URI
// appears, fetches that part once and reads its tfdt, so the part's end is
// exact (tfdt + duration) rather than a sum of rounded durations. A part's
// lag is (first seen - its end); the smallest lag in the run is the
// pipeline's own constant delay, so lateness is lag minus that minimum.
//
// Usage: SID=<session> node lateness.mjs <seconds>
// Prints one "LATENESS <track> ..." line per track, then a JSON dump.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadHarnessEnv, assertLocalUrl } from "./env.mjs";

const SID = process.env.SID;
if (!SID) {
  console.error("lateness.mjs: SID env var required");
  process.exit(2);
}
const ORIGIN = process.env.LL_HARNESS_ORIGIN || "http://127.0.0.1:8090";
assertLocalUrl(ORIGIN, "LL_HARNESS_ORIGIN");
const KEY = process.env.MEDIA_ORIGIN_KEY || loadHarnessEnv().MEDIA_ORIGIN_KEY;
const secs = Number(process.argv[2] || 60);
const POLL_MS = Number(process.env.POLL_MS || 10);
const TIMESCALE = { video: 90000, audio: 48000 };
// PARTS_DIR, when set, keeps every part's bytes and a parts.json index
// (uri, first seen, tfdt, duration) for offline inspection.
const PARTS_DIR = process.env.PARTS_DIR || "";
if (PARTS_DIR) mkdirSync(PARTS_DIR, { recursive: true });

const get = (path) => fetch(`${ORIGIN}/s/${SID}/${path}`, { headers: { "X-Pqp-Origin-Key": KEY } });

// tfdt, version 0 or 1, found by its fourcc: every fragment internal/cmaf
// writes has exactly one.
function tfdt(buf) {
  const i = buf.indexOf(Buffer.from("tfdt"));
  if (i < 0) return null;
  return buf[i + 4] === 1 ? Number(buf.readBigUInt64BE(i + 8)) : buf.readUInt32BE(i + 8);
}

const seen = { video: new Map(), audio: new Map() }; // uri -> {at, durationSecs}
const pending = [];
const deadline = Date.now() + secs * 1000;
while (Date.now() < deadline) {
  const t0 = Date.now();
  try {
    const r = await get("state.json");
    if (r.ok) {
      const at = Date.now();
      const st = await r.json();
      for (const track of ["video", "audio"]) {
        for (const seg of st[track]?.segments ?? []) {
          for (const p of seg.parts ?? []) {
            if (seen[track].has(p.uri)) continue;
            const rec = { at, durationSecs: p.durationSecs };
            seen[track].set(p.uri, rec);
            pending.push(
              get(p.uri)
                .then((res) => res.arrayBuffer())
                .then((b) => {
                  rec.tfdt = tfdt(Buffer.from(b));
                  if (PARTS_DIR) writeFileSync(path.join(PARTS_DIR, p.uri), Buffer.from(b));
                }),
            );
          }
        }
      }
    }
  } catch {
    // Origin not up yet, or the session between restarts: keep polling.
  }
  const wait = POLL_MS - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
await Promise.allSettled(pending);

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
const out = {};
for (const track of ["video", "audio"]) {
  const recs = [...seen[track].values()].filter((r) => r.tfdt != null);
  // The first poll finds whatever was already published before it started;
  // those parts' "first seen" says nothing about when they were published.
  const firstAt = Math.min(...recs.map((r) => r.at));
  const lags = recs.filter((r) => r.at > firstAt).map((r) => r.at - 1000 * (r.tfdt / TIMESCALE[track] + r.durationSecs));
  if (!lags.length) {
    console.log(`LATENESS ${track} n=0`);
    continue;
  }
  const floor = Math.min(...lags);
  const late = lags.map((l) => Math.round(l - floor)).sort((a, b) => a - b);
  const s = {
    n: late.length,
    p50: pct(late, 0.5),
    p90: pct(late, 0.9),
    p99: pct(late, 0.99),
    max: late.at(-1),
    over250: late.filter((l) => l > 250).length,
    over500: late.filter((l) => l > 500).length,
  };
  // Inter-arrival: the gap between consecutive parts first appearing, the
  // origin-side cadence a blocking reload sees. Parts that land in the same
  // poll count as one arrival.
  const arrivals = [...new Set(recs.filter((r) => r.at > firstAt).map((r) => r.at))].sort((a, b) => a - b);
  const gaps = arrivals.slice(1).map((a, i) => a - arrivals[i]).sort((a, b) => a - b);
  s.interP50 = gaps.length ? pct(gaps, 0.5) : null;
  s.interP99 = gaps.length ? pct(gaps, 0.99) : null;
  s.interMax = gaps.length ? gaps.at(-1) : null;
  out[track] = s;
  console.log(
    `LATENESS ${track} n=${s.n} p50=${s.p50}ms p90=${s.p90}ms p99=${s.p99}ms max=${s.max}ms over250=${s.over250} over500=${s.over500} interArrival p50=${s.interP50}ms p99=${s.interP99}ms max=${s.interMax}ms`,
  );
}
console.log("LATENESS_JSON", JSON.stringify(out));
if (PARTS_DIR) {
  const index = {};
  for (const track of ["video", "audio"]) index[track] = [...seen[track].entries()].map(([uri, r]) => ({ uri, ...r }));
  writeFileSync(path.join(PARTS_DIR, "parts.json"), JSON.stringify(index));
}

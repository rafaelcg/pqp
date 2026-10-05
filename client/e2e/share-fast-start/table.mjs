#!/usr/bin/env node
/**
 * One line per measured viewer from rig results:
 *
 *   node e2e/share-fast-start/table.mjs results/fin-*.json
 *
 * first = first decoded picture (ms from the page starting to join) and its
 * height; target = when the picture reached `--target` lines (default 720) and
 * stayed there; lost = times the share was taken away (republished) while
 * watching; kbps = mean of the last five seconds.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const ti = args.indexOf("--target");
const target = ti >= 0 ? Number(args.splice(ti, 2)[1]) : 720;

function viewerLine(name, i, v) {
  const samples = v.raw.samples.filter((s) => s.framesDecoded > 0 && s.h !== null);
  const sizes = v.raw.events.filter((e) => e.name === "size").map((e) => ({ t: e.t, h: e.data.h }));
  const first = v.raw.events.find((e) => e.name === "firstFrame");
  let reached = null;
  for (const s of sizes) {
    if (s.h >= target && s.h > 2) reached ??= s.t;
    else reached = null;
  }
  const lost = v.raw.events.filter((e) => e.name === "screenGone").length;
  const tail = v.raw.samples.slice(-20).filter((s) => s.kbps !== null);
  const kbps = tail.length ? Math.round(tail.reduce((a, s) => a + s.kbps, 0) / tail.length) : null;
  return {
    run: name,
    viewer: i,
    attempts: v.attempts ?? 1,
    first: first ? `${first.t} ms @ ${first.data.h}p` : "none",
    firstHeight: first?.data.h ?? null,
    target: reached,
    lost,
    path: sizes.map((s) => `${s.h}@${s.t}`).join(" "),
    kbps,
    decoded: samples.length > 0,
  };
}

const rows = [];
for (const file of args) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  const name = path.basename(file, ".json");
  r.viewers.forEach((v, i) => rows.push(viewerLine(name, i, v)));
}
for (const row of rows) {
  console.log(
    [row.run, `v${row.viewer}`, row.first, `target ${row.target ?? "never"}`, `lost ${row.lost}`, `${row.kbps} kbps`, row.path].join(" | "),
  );
}

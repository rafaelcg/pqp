// Desktop benchmark for the native GPUI prototype (rust/apps/desktop-proto,
// docs/plans/RUST.md step D2), against the same local stack, the same second
// participant and the same sampler as electron-bench.mjs, so its S1 and S4
// numbers sit beside the Electron baseline. See README.md, "The native runner".
//
//   cargo build --release --manifest-path rust/Cargo.toml
//   node tools/desktop-bench/native-bench.mjs                 check, then S1 and S4, 5 runs
//   node tools/desktop-bench/native-bench.mjs --smoke         check, then one short run of each
//   node tools/desktop-bench/native-bench.mjs --check-only    only the D2 exit check
//
// Options (env in brackets), as electron-bench.mjs plus:
//   --bin PATH       the prototype binary, default rust/target/release/pqp-desktop-proto [BENCH_NATIVE_BIN]
//   --compare FILE   an Electron result to put ratios against, default the newest
//                    non-smoke results/*-darwin-arm64-*.json that is not a native one
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startParticipant } from "./lib/call.mjs";
import { sleep } from "./lib/electron.mjs";
import { launchNative, snapshotNative } from "./lib/native.mjs";
import { holdAndMeasure, measureWindow } from "./lib/scenes.mjs";
import { ensureClientBuild, repo, startStack } from "./lib/stack.mjs";
import { summarizeScene } from "./lib/stats.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function args() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const val = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const smoke = flag("smoke");
  return {
    smoke,
    checkOnly: flag("check-only"),
    runs: Number(val("runs", smoke ? 1 : 5)),
    callSeconds: Number(val("call-seconds", process.env.BENCH_CALL_SECONDS ?? (smoke ? 20 : 300))),
    cpuWindowSeconds: Number(val("cpu-window", process.env.BENCH_CPU_WINDOW_SECONDS ?? (smoke ? 8 : 30))),
    out: val("out", null),
    pgAdminUrl: val("pg-admin", process.env.BENCH_PG_ADMIN_URL ?? "postgres://postgres:bench@127.0.0.1:55439/postgres"),
    clientDist: val("client-dist", process.env.BENCH_CLIENT_DIST ?? null),
    bin: val("bin", process.env.BENCH_NATIVE_BIN ?? path.join(repo, "rust", "target", "release", "pqp-desktop-proto")),
    compare: val("compare", null),
  };
}

const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const sh = (cmd, a) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/**
 * Bob's side of "both sides measure the other's audio level": every
 * RTCPeerConnection the web client opens is kept, so the inbound audio's
 * energy can be read from its stats. Installed only in the second
 * participant's page, never in anything measured.
 */
const RECORD_PEER_CONNECTIONS = () => {
  const Orig = window.RTCPeerConnection;
  if (!Orig || window.__benchPcs) return;
  window.__benchPcs = [];
  function Recorded(...a) {
    const pc = new Orig(...a);
    window.__benchPcs.push(pc);
    return pc;
  }
  Recorded.prototype = Orig.prototype;
  Object.setPrototypeOf(Recorded, Orig);
  window.RTCPeerConnection = Recorded;
};

/** Inbound audio counters across every peer connection of the page. */
async function inboundAudio(page) {
  return page.evaluate(async () => {
    let energy = 0;
    let seconds = 0;
    let packets = 0;
    let streams = 0;
    for (const pc of window.__benchPcs ?? []) {
      if (pc.connectionState === "closed") continue;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio") {
          streams += 1;
          energy += s.totalAudioEnergy ?? 0;
          seconds += s.totalSamplesDuration ?? 0;
          packets += s.packetsReceived ?? 0;
        }
      });
    }
    return { energy, seconds, packets, streams, at: Date.now() };
  });
}

/** Mean level between two counter readings, dBFS (null if nothing played). */
function levelBetween(a, b) {
  const dE = b.energy - a.energy;
  const dT = b.seconds - a.seconds;
  return {
    dbfs: dT > 0 && dE > 0 ? Math.round(10 * Math.log10(dE / dT) * 10) / 10 : null,
    packets: b.packets - a.packets,
    seconds: Math.round(dT * 10) / 10,
  };
}

/**
 * Whatever is open right now (the prototype, the second participant), so a
 * Ctrl-C closes them before the stack: a browser still connected to the
 * static server would otherwise hold its close open.
 */
const open = new Set();
async function closeOpen() {
  for (const item of [...open]) {
    open.delete(item);
    await item.close().catch(() => {});
  }
}

const lightRoute = (stack) => `/app/server/${stack.ids.serverId}/channel/${stack.ids.lightChannelId}?lang=en`;

function nativeEnv(stack) {
  return {
    PQP_API_URL: stack.apiUrl,
    PQP_WS_URL: stack.wsUrl,
    PQP_TOKEN: "dev-local-token",
    PQP_SERVER_NAME: "Sandbox",
    PQP_CHANNEL: "general",
  };
}

async function openNative(stack, cfg, log) {
  const n = launchNative({ bin: cfg.bin, env: nativeEnv(stack), log });
  open.add(n);
  const close = n.close;
  n.close = async () => {
    open.delete(n);
    await close();
  };
  try {
    const first = await n.waitLine("FIRST_CONTENT", 60_000);
    await n.waitLine("READY", 60_000);
    return { n, contentMs: Number(first.rest) - n.t0 };
  } catch (error) {
    await n.close();
    throw error;
  }
}

/** Bob in the call, then the prototype joins it: the order the Electron S4 uses. */
async function joinWithBob(stack, n) {
  const participant = await startParticipant({ stack, route: lightRoute(stack), initScripts: [RECORD_PEER_CONNECTIONS] });
  const handle = { close: () => participant.stop() };
  open.add(handle);
  const bob = {
    page: participant.page,
    stop: async () => {
      open.delete(handle);
      await participant.stop();
    },
  };
  try {
    const since = Date.now();
    n.send("join Lobby");
    const inCall = await n.waitLine("IN_CALL", 45_000, since);
    if (!JSON.parse(inCall.rest).micPublished) throw new Error("the prototype joined without a microphone");
    await n.waitLine("REMOTE_AUDIO", 30_000, since);
    return bob;
  } catch (error) {
    await bob.stop();
    throw error;
  }
}

/**
 * The D2 exit, checked once and recorded (not timed): a two-person call with
 * the web client in which both sides measure the other's audio level, plus
 * mute, deafen and the roster round trip through /ws.
 */
async function d2Check(stack, cfg, log) {
  const { n } = await openNative(stack, cfg, log);
  let bob = null;
  const out = {};
  try {
    bob = await joinWithBob(stack, n);
    await sleep(6_000);
    const b0 = await inboundAudio(bob.page);
    await sleep(6_000);
    const b1 = await inboundAudio(bob.page);
    const st = await n.status();
    out.call = {
      rosterSize: st.roster.length,
      roster: st.roster.map((p) => p.name),
      nativeHearsOther: { peakDbfs: st.remotePeakDbfs, audibleSeconds: st.remoteAudibleSeconds, framesIn: st.remoteFramesIn },
      otherHearsNative: levelBetween(b0, b1),
      speakingSeen: st.speaking,
    };

    n.send("mute");
    await sleep(3_000);
    const m0 = await inboundAudio(bob.page);
    await sleep(4_000);
    const m1 = await inboundAudio(bob.page);
    const stMuted = await n.status();
    out.mute = { selfMutedOnServer: stMuted.self?.muted ?? null, otherHearsNative: levelBetween(m0, m1) };

    n.send("unmute");
    await sleep(3_000);
    const u0 = await inboundAudio(bob.page);
    await sleep(4_000);
    const u1 = await inboundAudio(bob.page);
    const stUnmuted = await n.status();
    out.unmute = { selfMutedOnServer: stUnmuted.self?.muted ?? null, otherHearsNative: levelBetween(u0, u1) };

    // Deafen: the SFU stops forwarding the other person's audio and the
    // microphone is muted with it. The playout pull keeps handing the meter
    // 10 ms frames (concealment), so the proof is their level: silence, where
    // a locally disabled track alone still meters the full signal.
    n.send("deafen");
    await sleep(3_000);
    const d0 = await n.status();
    const db0 = await inboundAudio(bob.page);
    await sleep(4_000);
    const d1 = await n.status();
    const db1 = await inboundAudio(bob.page);
    out.deafen = {
      selfDeafenedOnServer: d1.self?.deafened ?? null,
      framesInWhileDeafened: d1.remoteFramesIn - d0.remoteFramesIn,
      nativeLevelWhileDeafenedDbfs: d1.remoteLevelDbfs,
      otherHearsNative: levelBetween(db0, db1),
    };
    n.send("undeafen");
    await sleep(3_000);
    const ud0 = await n.status();
    await sleep(3_000);
    const ud1 = await n.status();
    out.undeafen = {
      selfDeafenedOnServer: ud1.self?.deafened ?? null,
      framesInAfter: ud1.remoteFramesIn - ud0.remoteFramesIn,
      nativeLevelDbfs: ud1.remoteLevelDbfs,
    };

    const a = out.call;
    out.pass =
      a.rosterSize === 2 &&
      (a.nativeHearsOther.audibleSeconds ?? 0) > 0 &&
      a.otherHearsNative.dbfs != null &&
      a.otherHearsNative.dbfs > -60 &&
      out.mute.selfMutedOnServer === true &&
      (out.mute.otherHearsNative.dbfs == null || out.mute.otherHearsNative.dbfs < -60) &&
      out.unmute.selfMutedOnServer === false &&
      out.unmute.otherHearsNative.dbfs != null &&
      out.unmute.otherHearsNative.dbfs > -60 &&
      out.deafen.selfDeafenedOnServer === true &&
      (out.deafen.nativeLevelWhileDeafenedDbfs == null || out.deafen.nativeLevelWhileDeafenedDbfs < -60) &&
      out.deafen.otherHearsNative.packets === 0 &&
      out.undeafen.selfDeafenedOnServer === false &&
      out.undeafen.nativeLevelDbfs != null &&
      out.undeafen.nativeLevelDbfs > -60;
    n.send("leave");
    await sleep(1_000);
  } finally {
    await bob?.stop();
    await n.close();
  }
  return out;
}

async function s1(stack, cfg, log) {
  const { n, contentMs } = await openNative(stack, cfg, log);
  try {
    await sleep(15_000);
    const m = await measureWindow(n.pid, cfg.cpuWindowSeconds, snapshotNative);
    return { S1: { ...m, extras: { startup: { contentMs } } } };
  } finally {
    await n.close();
  }
}

async function s4(stack, cfg, log) {
  const { n } = await openNative(stack, cfg, log);
  let bob = null;
  try {
    bob = await joinWithBob(stack, n);
    const extras = { micOn: 1 };
    let b0 = null;
    const result = await holdAndMeasure(
      n.pid,
      cfg.callSeconds,
      async (phase) => {
        if (phase === "start") {
          b0 = await inboundAudio(bob.page);
          return;
        }
        const b1 = await inboundAudio(bob.page);
        const st = await n.status();
        extras.otherHearsNative = levelBetween(b0, b1);
        extras.nativeHearsOther = {
          peakDbfs: st.remotePeakDbfs,
          audibleSeconds: st.remoteAudibleSeconds,
          framesIn: st.remoteFramesIn,
        };
        extras.rosterSize = st.roster.length;
      },
      snapshotNative,
    );
    n.send("leave");
    await sleep(500);
    return { S4: { ...result, extras } };
  } finally {
    await bob?.stop();
    await n.close();
  }
}

function binaryInfo(bin) {
  const lock = readFileSync(path.join(repo, "rust", "Cargo.lock"), "utf8");
  const packages = (lock.match(/^\[\[package\]\]$/gm) ?? []).length;
  return {
    path: path.relative(repo, bin),
    sizeBytes: statSync(bin).size,
    sha256: createHash("sha256").update(readFileSync(bin)).digest("hex"),
    cargoLockPackages: packages,
    rustc: sh("rustc", ["--version"]),
  };
}

function newestElectronResult() {
  const dir = path.join(here, "results");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.includes("smoke") && !f.includes("native") && f.includes(`${process.platform}-${process.arch}`))
    .sort();
  return files.length ? path.join(dir, files.at(-1)) : null;
}

/** Native median over Electron median, per scene and metric. */
function compareWith(file, scenes) {
  if (!file || !existsSync(file)) return null;
  const e = JSON.parse(readFileSync(file, "utf8"));
  const out = { against: path.relative(repo, file), electronAppSha: e.build?.appSha ?? null, scenes: {} };
  for (const id of Object.keys(scenes)) {
    const ns = scenes[id]?.summary;
    const es = e.scenes?.[id]?.summary;
    if (!ns || !es) continue;
    const ratio = (a, b) => (a != null && b ? Math.round((a / b) * 1000) / 10 : null);
    out.scenes[id] = {
      memMB: { native: ns.memTotalMB?.median ?? null, electron: es.memTotalMB?.median ?? null, pctOfElectron: ratio(ns.memTotalMB?.median, es.memTotalMB?.median) },
      cpuPct: { native: ns.cpuTotalPct?.median ?? null, electron: es.cpuTotalPct?.median ?? null, pctOfElectron: ratio(ns.cpuTotalPct?.median, es.cpuTotalPct?.median) },
    };
  }
  return out;
}

async function main() {
  const cfg = args();
  const log = (m) => console.error(`[native ${new Date().toISOString().slice(11, 19)}] ${m}`);
  if (!existsSync(cfg.bin)) throw new Error(`no binary at ${cfg.bin}: cargo build --release --manifest-path rust/Cargo.toml`);
  const head = git("rev-parse", "HEAD");
  let base = head;
  try {
    base = git("merge-base", "HEAD", "origin/main");
  } catch {
    // no origin/main
  }
  const outFile =
    cfg.out ??
    path.join(
      here,
      "results",
      `${new Date().toISOString().slice(0, 10)}-${process.platform}-${process.arch}-${head.slice(0, 9)}-native${cfg.smoke ? "-smoke" : ""}${cfg.checkOnly ? "-check" : ""}.json`,
    );
  mkdirSync(path.dirname(outFile), { recursive: true });

  const clientDist = cfg.clientDist ?? path.join(os.tmpdir(), "pqp-desktop-bench-client-dist");
  if (!cfg.clientDist) ensureClientBuild({ outDir: clientDist, log, force: process.env.BENCH_REBUILD === "1" });
  const stack = await startStack({ pgAdminUrl: cfg.pgAdminUrl, clientDist, log });
  if (!stack.livekit) {
    await stack.stop();
    throw new Error("livekit-server is not installed: the call scene cannot run (brew install livekit)");
  }

  const mac = process.platform === "darwin";
  const result = {
    schema: 1,
    tool: "tools/desktop-bench/native-bench.mjs",
    app: "rust/apps/desktop-proto (GPUI + LiveKit Rust SDK), plan step D2",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    smoke: cfg.smoke,
    machine: {
      model: mac ? sh("sysctl", ["-n", "hw.model"]) : null,
      cpu: mac ? sh("sysctl", ["-n", "machdep.cpu.brand_string"]) : os.cpus()[0]?.model,
      cores: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 2 ** 30),
      power: mac ? (sh("pmset", ["-g", "batt"]) ?? "").split("\n")[0] : null,
    },
    os: { platform: process.platform, arch: process.arch, release: os.release(), version: mac ? sh("sw_vers", ["-productVersion"]) : os.version() },
    node: process.versions.node,
    build: { headSha: head, mainBase: base, binary: binaryInfo(cfg.bin) },
    config: {
      runsPerScene: cfg.runs,
      callSeconds: cfg.callSeconds,
      cpuWindowSeconds: cfg.cpuWindowSeconds,
      stack: {
        livekit: true,
        microphone: "synthetic 440 Hz beep (250 ms of every second) in a NativeAudioSource, published as TrackSource::Microphone, WebRTC AEC/NS/AGC on; the real microphone is never opened",
        playout: "WebRTC platform ADM (CoreAudio) through livekit::PlatformAudio",
        participant: "headless Chromium, dev-local-token:bob, not measured",
      },
    },
    thermalBefore: mac ? sh("pmset", ["-g", "therm"]) : null,
    thermalAfter: null,
    d2Check: null,
    scenes: {},
    comparison: null,
  };
  const raw = {};
  const refresh = () => {
    for (const [id, runs] of Object.entries(raw)) {
      result.scenes[id] = { summary: summarizeScene(runs), runs };
    }
    result.comparison = compareWith(cfg.compare ?? newestElectronResult(), result.scenes);
    writeFileSync(outFile, JSON.stringify(result, null, 2));
  };
  const onSignal = (code) => () =>
    closeOpen()
      .then(() => stack.stop())
      .finally(() => process.exit(code));
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));

  try {
    log("D2 exit check: two-person call with the web client, both sides measure the other");
    try {
      result.d2Check = await d2Check(stack, cfg, log);
    } catch (error) {
      result.d2Check = { pass: false, error: String(error?.message ?? error).slice(0, 500) };
    }
    log(`  ${result.d2Check.pass ? "PASS" : "FAIL"} ${JSON.stringify(result.d2Check).slice(0, 400)}`);
    refresh();
    if (!cfg.checkOnly) {
      for (let round = 1; round <= cfg.runs; round++) {
        for (const [id, run] of [["S1", s1], ["S4", s4]]) {
          log(`round ${round}/${cfg.runs}: ${id}`);
          try {
            const out = await run(stack, cfg, log);
            for (const [k, r] of Object.entries(out)) {
              (raw[k] ??= []).push(r);
              log(`  ${k}: ${r.memory.totalMB} MB, ${r.cpu.totalPct}% CPU`);
            }
          } catch (error) {
            log(`  FAILED: ${error?.message ?? error}`);
            (raw[id] ??= []).push({ error: String(error?.message ?? error).slice(0, 500) });
          }
          refresh();
          await sleep(cfg.smoke ? 2_000 : 10_000);
        }
      }
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    result.thermalAfter = mac ? sh("pmset", ["-g", "therm"]) : null;
    refresh();
    await stack.stop();
  }
  log(`wrote ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

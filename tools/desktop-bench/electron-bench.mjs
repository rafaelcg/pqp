// Desktop benchmark for the real Electron shell (electron/main.js, unchanged)
// against a local production build of the web client and a scratch local API
// with the dev auth bypass. docs/plans/RUST.md, Phase B. See README.md.
//
//   node tools/desktop-bench/electron-bench.mjs                  all scenes, 5 runs
//   node tools/desktop-bench/electron-bench.mjs --scenes S1,S8 --runs 3
//   node tools/desktop-bench/electron-bench.mjs --smoke          every scene once, short
//
// Options (env in brackets):
//   --scenes S1,S4   which scenes (S2 and S3 run together)
//   --runs N         runs per scene, default 5 (the plan's floor)
//   --call-seconds   S4 to S7 length, default 300 [BENCH_CALL_SECONDS]
//   --cpu-window     S1 to S3 CPU window, default 30 [BENCH_CPU_WINDOW_SECONDS]
//   --out FILE       result JSON, default results/<date>-<os>-<arch>-<sha>.json
//   --pg-admin URL   admin URL of a LOCAL Postgres [BENCH_PG_ADMIN_URL]
//   --client-dist D  a client build to serve instead of building one [BENCH_CLIENT_DIST]
//   --smoke          one run, 20 s calls, 8 s CPU windows; the file name says so
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient, repo, startStack } from "./lib/stack.mjs";
import { SCENE_GROUPS, SCENE_NAMES } from "./lib/scenes.mjs";
import { sleep } from "./lib/electron.mjs";
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
    scenes: val("scenes", "").split(",").filter(Boolean),
    runs: Number(val("runs", smoke ? 1 : 5)),
    callSeconds: Number(val("call-seconds", process.env.BENCH_CALL_SECONDS ?? (smoke ? 20 : 300))),
    cpuWindowSeconds: Number(val("cpu-window", process.env.BENCH_CPU_WINDOW_SECONDS ?? (smoke ? 8 : 30))),
    out: val("out", null),
    pgAdminUrl: val("pg-admin", process.env.BENCH_PG_ADMIN_URL ?? "postgres://postgres:bench@127.0.0.1:55439/postgres"),
    clientDist: val("client-dist", process.env.BENCH_CLIENT_DIST ?? null),
  };
}

const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

/**
 * Which commit the numbers describe. The code under test is `appSha`: HEAD,
 * unless everything that differs from `origin/main` lives under
 * tools/desktop-bench (the bench itself, which is not the app), in which case
 * it is the merge base, i.e. current main. `dirty` is true only when app code
 * differs from `appSha`.
 */
function buildInfo() {
  const head = git("rev-parse", "HEAD");
  let base = head;
  try {
    base = git("merge-base", "HEAD", "origin/main");
  } catch {
    // no origin/main: HEAD is all we can say
  }
  const changed = [
    ...git("diff", "--name-only", base).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ].filter(Boolean);
  const appChanged = changed.filter((f) => !f.startsWith("tools/desktop-bench/") && !f.startsWith("docs/"));
  return {
    appSha: appChanged.length === 0 ? base : head,
    benchHeadSha: head,
    dirty: appChanged.length > 0,
    dirtyFiles: appChanged.slice(0, 20),
  };
}

function sh(cmd, a) {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function machineInfo() {
  const mac = process.platform === "darwin";
  return {
    machine: {
      model: mac ? sh("sysctl", ["-n", "hw.model"]) : null,
      cpu: mac ? sh("sysctl", ["-n", "machdep.cpu.brand_string"]) : os.cpus()[0]?.model,
      cores: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 2 ** 30),
      power: mac ? (sh("pmset", ["-g", "batt"]) ?? "").split("\n")[0] : null,
      lowPowerMode: mac ? /lowpowermode\s+1/i.test(sh("pmset", ["-g"]) ?? "") : null,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: mac ? sh("sw_vers", ["-productVersion"]) : os.version(),
    },
    node: process.versions.node,
  };
}

const thermal = () => (process.platform === "darwin" ? sh("pmset", ["-g", "therm"]) : null);

async function main() {
  const cfg = args();
  const log = (m) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${m}`);
  const wanted = (g) => cfg.scenes.length === 0 || g.ids.some((id) => cfg.scenes.includes(id));
  const groups = SCENE_GROUPS.filter(wanted);

  const info = { ...machineInfo(), build: buildInfo() };
  const outFile =
    cfg.out ??
    path.join(
      here,
      "results",
      `${new Date().toISOString().slice(0, 10)}-${process.platform}-${process.arch}-${info.build.appSha.slice(0, 9)}${cfg.smoke ? "-smoke" : ""}.json`,
    );
  mkdirSync(path.dirname(outFile), { recursive: true });

  const clientDist = cfg.clientDist ?? path.join(os.tmpdir(), "pqp-desktop-bench-client-dist");
  if (!cfg.clientDist) {
    if (!existsSync(path.join(clientDist, "index.html")) || process.env.BENCH_REBUILD === "1") {
      buildClient({ outDir: clientDist, log });
    }
  }

  const stack = await startStack({ pgAdminUrl: cfg.pgAdminUrl, clientDist, log });
  const missing = [];
  const result = {
    schema: 1,
    tool: "tools/desktop-bench",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    smoke: cfg.smoke,
    ...info,
    config: {
      runsPerScene: cfg.runs,
      callSeconds: cfg.callSeconds,
      cpuWindowSeconds: cfg.cpuWindowSeconds,
      stack: {
        livekit: Boolean(stack.livekit),
        fakeCapture: "Chromium fake device, 1920x1080; the share scenes do not capture the OS screen",
        participant: "headless Chromium, dev-local-token:bob, not measured",
      },
    },
    thermalBefore: thermal(),
    thermalAfter: null,
    electron: null,
    scenes: {},
  };
  const write = () => writeFileSync(outFile, JSON.stringify(result, null, 2));

  const raw = {};
  const stop = async () => {
    await stack.stop();
  };
  process.on("SIGINT", () => stop().finally(() => process.exit(130)));
  process.on("SIGTERM", () => stop().finally(() => process.exit(143)));

  try {
    // Round-robin: run 1 of every scene, then run 2 of every scene, so slow
    // drift (heat, background work) is spread across scenes instead of
    // landing on the last one.
    for (let round = 1; round <= cfg.runs; round++) {
      for (const group of groups) {
        if (group.needs.includes("livekit") && !stack.livekit) {
          for (const id of group.ids) if (!missing.includes(id)) missing.push(id);
          continue;
        }
        log(`round ${round}/${cfg.runs}: ${group.ids.join("+")}`);
        let out;
        try {
          out = await group.run(stack, cfg);
        } catch (error) {
          log(`  FAILED: ${error?.message ?? error}`);
          for (const id of group.ids) {
            (raw[id] ??= []).push({ error: String(error?.message ?? error).slice(0, 500) });
          }
          await sleep(5_000);
          continue;
        }
        for (const [id, r] of Object.entries(out)) {
          (raw[id] ??= []).push(r);
          result.electron ??= r.versions ?? null;
          const m = r.memory?.totalMB;
          const c = r.cpu?.totalPct;
          log(`  ${id}: ${m != null ? `${m} MB` : ""}${c != null ? `, ${c}% CPU` : ""}`);
        }
        for (const [id, runs] of Object.entries(raw)) {
          result.scenes[id] = {
            name: SCENE_NAMES[id],
            summary: summarizeScene(runs),
            runs: runs.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "versions"))),
          };
        }
        result.missingScenes = missing;
        write();
        await sleep(cfg.smoke ? 2_000 : 10_000);
      }
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    result.thermalAfter = thermal();
    result.missingScenes = missing;
    write();
    await stop();
  }
  log(`wrote ${outFile}`);
  if (missing.length) log(`NOT RUN (no livekit-server): ${missing.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Launching the real Electron shell (electron/main.js, unchanged) against the
// bench stack, and measuring every process it owns.
//
// ONE instance at a time, in its own user-data directory, with its pid tracked:
// the owner's installed pqp app may be running on the same machine, and this
// never names, matches or signals anything but the pid it launched.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cpuSeconds, mb, processMemoryBytes } from "../footprint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const electronRoot = path.resolve(here, "../../../electron");
const require = createRequire(path.join(electronRoot, "package.json"));
export const { _electron, chromium } = require("@playwright/test");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chromium switches that make the call scenes unattended: fake mic and camera, no prompts. */
export const FAKE_MEDIA_ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream=fps=30"];

export function freshUserDataDir() {
  return mkdtempSync(path.join(tmpdir(), "pqp-bench-ud-"));
}

/**
 * Launch the shell on `url`. Returns the Playwright handle plus the main
 * process pid and a `close()` that cannot leave the instance running.
 */
export async function launchElectron({ url, userDataDir, extraArgs = [] }) {
  const t0 = Date.now();
  const app = await _electron.launch({
    args: [electronRoot, `--user-data-dir=${userDataDir}`, ...FAKE_MEDIA_ARGS, ...extraArgs],
    env: { ...process.env, PQP_APP_URL: url, NODE_ENV: "test", PQP_DISABLE_AUTO_UPDATE: "1" },
  });
  const pid = app.process().pid;
  const page = await app.firstWindow();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.race([app.close().catch(() => {}), sleep(10_000)]);
    // The pid we launched, and only it; its helpers go with it.
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  return { app, page, pid, t0, tWindow: Date.now(), close };
}

/** Pids and kinds of every process the app owns right now. */
export async function appMetrics(app) {
  return app.evaluate(({ app: a }) => a.getAppMetrics());
}

/** "Tab", "GPU", "Utility: Network Service", "Browser"... one key per kind of process. */
export function processKey(m) {
  return m.type === "Utility" && (m.name || m.serviceName) ? `Utility: ${m.name || m.serviceName}` : m.type;
}

/** One snapshot: memory per process, and the CPU seconds counter to difference later. */
export async function snapshot(app) {
  const metrics = await appMetrics(app);
  const at = Date.now();
  const rows = metrics.map((m) => ({
    pid: m.pid,
    key: processKey(m),
    memBytes: processMemoryBytes(m),
    cpuSeconds: m.cpu?.cumulativeCPUUsage ?? cpuSeconds(m.pid),
  }));
  return { at, rows };
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Memory view of one snapshot: total and per process kind (summed within a kind). */
export function memoryOf(snap) {
  const byKey = {};
  let total = 0;
  for (const r of snap.rows) {
    const b = r.memBytes ?? 0;
    total += b;
    byKey[r.key] = (byKey[r.key] ?? 0) + b;
  }
  return {
    totalMB: mb(total),
    processCount: snap.rows.length,
    byKeyMB: Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, mb(v)])),
    byProcess: snap.rows.map((r) => ({ pid: r.pid, key: r.key, mb: mb(r.memBytes) })),
  };
}

/**
 * CPU between two snapshots, in percent of ONE core (so 100 is a full core and
 * a busy renderer plus GPU can exceed 100). A process that is not in both
 * snapshots is left out of that window rather than guessed.
 */
export function cpuBetween(a, b) {
  const seconds = (b.at - a.at) / 1000;
  const before = new Map(a.rows.map((r) => [r.pid, r]));
  const byKey = {};
  const byProcess = [];
  let total = 0;
  for (const r of b.rows) {
    const p = before.get(r.pid);
    if (!p || p.cpuSeconds == null || r.cpuSeconds == null) continue;
    const pct = ((r.cpuSeconds - p.cpuSeconds) / seconds) * 100;
    total += pct;
    byKey[r.key] = (byKey[r.key] ?? 0) + pct;
    byProcess.push({ pid: r.pid, key: r.key, pct: round(pct, 2) });
  }
  return {
    windowSeconds: round(seconds, 1),
    totalPct: round(total, 2),
    byKeyPct: Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, round(v, 2)])),
    byProcess,
  };
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// Per-process memory and CPU, comparable across the stacks the plan measures.
//
//   macOS    phys_footprint (what Activity Monitor shows). RSS double counts the
//            pages Chromium and WebKit helpers share; footprint does not.
//   Windows  private working set, from Electron's own `getAppMetrics`
//            (`memory.privateBytes`, which Chromium reports in KB).
//   Linux    PSS from /proc/<pid>/smaps_rollup (shared pages divided among the
//            processes that map them), the closest thing to footprint there.
//
// CPU is cumulative CPU seconds per pid (Electron's `cumulativeCPUUsage`, with
// `ps` cputime as the fallback), differenced over a window by the caller.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const mb = (b) => (b == null ? null : Math.round((b / 1024 / 1024) * 10) / 10);

export function physFootprintBytes(pid) {
  try {
    const out = execFileSync("footprint", ["--noCategories", "-f", "bytes", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/phys_footprint:\s+(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function linuxPssBytes(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+) kB/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Memory in bytes for one process of Electron's `getAppMetrics()` list.
 * `metric.memory` is Electron's own view and is used only where the OS offers
 * nothing better (Windows).
 */
export function processMemoryBytes(metric, platform = process.platform) {
  if (platform === "darwin") return physFootprintBytes(metric.pid);
  if (platform === "linux") return linuxPssBytes(metric.pid) ?? (metric.memory?.workingSetSize ?? 0) * 1024;
  const priv = metric.memory?.privateBytes;
  return (priv ?? metric.memory?.workingSetSize ?? 0) * 1024;
}

/** Back-compat for the older scripts: [{pid, type}] to rows with `footprint`. */
export function footprintFor(pids) {
  const rows = pids.map((p) => ({ ...p, footprint: physFootprintBytes(p.pid) }));
  const total = rows.reduce((sum, r) => sum + (r.footprint ?? 0), 0);
  return { rows, total };
}

/** Every process on the box: pid, ppid, %cpu, command. */
export function psTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,comm="], { encoding: "utf8" });
  return out
    .trim()
    .split("\n")
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), comm: m[4] } : null;
    })
    .filter(Boolean);
}

/** CPU seconds consumed by a pid so far (user+sys), from ps cputime. */
export function cpuSeconds(pid) {
  try {
    const t = execFileSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).trim();
    // [[dd-]hh:]mm:ss.cc
    const parts = t.split(/[-:]/).map(Number);
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s;
  } catch {
    return null;
  }
}

// macOS memory as Activity Monitor reports it: phys_footprint per process.
// RSS double counts shared pages across Chromium/WebKit helpers; footprint does
// not, so it is the fair number when comparing Electron to a system webview.
import { execFileSync } from "node:child_process";

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

export const mb = (b) => (b == null ? null : Math.round((b / 1024 / 1024) * 10) / 10);

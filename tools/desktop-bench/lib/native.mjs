// Launching the native desktop prototype (rust/apps/desktop-proto, plan step D2)
// against the bench stack, and measuring it with the SAME readers the Electron
// scenes use: macOS phys_footprint per process (footprint.mjs) and cumulative
// CPU seconds, differenced by `cpuBetween` from electron.mjs. The rows have the
// shape `snapshot()` produces for Electron, so `memoryOf` and `cpuBetween` are
// shared and the two numbers come from one sampler.
//
// The binary is started by pid, in its own process group, and stopped by that
// pid only. Nothing here names or matches a process by name.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cpuSeconds, physFootprintBytes, psTable } from "../footprint.mjs";
import { sleep } from "./electron.mjs";

/** The pid and every descendant of it, right now. */
function processTree(root) {
  const rows = psTable();
  const pids = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (pids.has(r.ppid) && !pids.has(r.pid)) {
        pids.add(r.pid);
        grew = true;
      }
    }
  }
  return rows.filter((r) => pids.has(r.pid));
}

/** One snapshot in the Electron snapshot's shape: {at, rows:[{pid,key,memBytes,cpuSeconds}]}. */
export function snapshotNative(pid) {
  const at = Date.now();
  const tree = processTree(pid);
  // A prototype that died must fail the run, never read as a free one.
  if (!tree.some((r) => r.pid === pid)) throw new Error(`the prototype (pid ${pid}) is not running`);
  const rows = tree.map((r) => ({
    pid: r.pid,
    key: r.pid === pid ? "Main" : `Child: ${r.comm.split("/").pop()}`,
    memBytes: physFootprintBytes(r.pid),
    cpuSeconds: cpuSeconds(r.pid),
  }));
  return { at, rows };
}

/**
 * Start the binary. Returns line waiters for its stdout protocol (see
 * rust/apps/desktop-proto/src/main.rs), `send` for stdin commands, and a
 * `close()` that cannot leave it running.
 */
export function launchNative({ bin, env = {}, log = () => {} }) {
  const t0 = Date.now();
  const child = spawn(bin, [], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const lines = [];
  const waiters = [];
  const stderr = [];
  child.stderr.on("data", (c) => {
    stderr.push(c.toString());
    if (stderr.length > 200) stderr.shift();
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const at = Date.now();
    const sp = line.indexOf(" ");
    const tag = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1);
    const entry = { tag, rest, at };
    lines.push(entry);
    if (tag === "ERROR") log(`native: ${line}`);
    for (const w of [...waiters]) {
      if (w.tag === tag && w.since <= at) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(entry);
      }
    }
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
    for (const w of waiters.splice(0)) w.reject(new Error(`native exited before ${w.tag}`));
  });

  /** The next line with this tag at or after `since` (default: any seen so far counts). */
  const waitLine = (tag, timeoutMs = 60_000, since = 0) => {
    const seen = lines.find((l) => l.tag === tag && l.at >= since);
    if (seen) return Promise.resolve(seen);
    if (exited) return Promise.reject(new Error(`native exited before ${tag}; stderr: ${stderr.join("").slice(-800)}`));
    return new Promise((resolve, reject) => {
      const w = { tag, since, resolve, reject };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error(`timed out waiting for ${tag}; last lines: ${lines.slice(-5).map((l) => `${l.tag} ${l.rest}`).join(" | ")}`));
        }
      }, timeoutMs);
    });
  };
  const send = (cmd) => {
    if (!exited) child.stdin.write(`${cmd}\n`);
  };
  /** Ask for STATUS and parse it. */
  const status = async () => {
    const since = Date.now();
    send("status");
    const l = await waitLine("STATUS", 10_000, since);
    return JSON.parse(l.rest);
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (!exited) {
      send("quit");
      const done = new Promise((r) => child.once("exit", r));
      await Promise.race([done, sleep(8_000)]);
    }
    if (!exited) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  };
  return { pid: child.pid, t0, child, waitLine, send, status, close, lines };
}

/**
 * Raise the priority of the shell's own processes while a screen share is live,
 * and put it back afterwards. Part of `share_high_motion_guard`: the page asks
 * (`setShareLive`) only when that runtime flag is on for the call's server.
 *
 * WHY. A game at several hundred frames per second keeps every core it can get
 * and the GPU at 100 %. The share's pipeline is split across this shell's
 * processes: the browser process runs the desktop capture, a renderer runs the
 * WebRTC encoder, the GPU process does the colour conversion and the hardware
 * encode, and the audio service feeds the microphone. All of them start at
 * normal priority and all of them lose the scheduler to the game. Normal to
 * above-normal is the smallest step that changes who wins.
 *
 * WHAT IT DOES NOT DO. It does not touch GPU scheduling (Windows has a
 * separate per-process GPU priority class that Node cannot set), it never goes
 * past above-normal (HIGH starves the processes that keep the machine
 * responsive, and REALTIME needs elevation), it never lowers a process that is
 * already higher, and it does nothing outside Windows: on macOS and Linux a
 * normal user cannot raise priority (only lower it), so the honest answer there
 * is "unsupported", not a call that fails with EACCES.
 *
 * RESTORES EXACTLY. Every process's own previous priority is remembered and
 * written back, not assumed to be normal. A process that has exited in the
 * meantime is skipped.
 *
 * KEEPS UP. Chromium respawns renderers and the GPU process, and may rewrite a
 * process's priority class when its visibility changes, so while live this
 * rescans every few seconds: new processes are raised, and one that was
 * dropped back is raised again.
 */

/** Node's `os.constants.priority` values, written out so the tests do not need an OS. */
const DEFAULT_PRIORITIES = Object.freeze({
  NORMAL: 0,
  ABOVE_NORMAL: -7,
});

const RESCAN_MS = 5_000;

/**
 * Which of `app.getAppMetrics()`'s entries are part of the share's pipeline.
 * The browser process (desktop capture), renderers ("Tab"), the GPU process,
 * and the two utility services the call depends on: audio and video capture.
 * The network service, the crashpad handler and the rest stay where they are.
 *
 * @param {{ pid: number, type?: string, name?: string, serviceName?: string }} metric
 */
function isShareProcess(metric) {
  if (!metric || !Number.isInteger(metric.pid) || metric.pid <= 0) {
    return false;
  }
  switch (metric.type) {
    case "Browser":
    case "Tab":
    case "GPU":
      return true;
    case "Utility": {
      const label = `${metric.name ?? ""} ${metric.serviceName ?? ""}`;
      return /audio|capture/i.test(label);
    }
    default:
      return false;
  }
}

/**
 * @param {{
 *   platform: string,
 *   listProcesses: () => Array<{ pid: number, type?: string, name?: string, serviceName?: string }>,
 *   getPriority: (pid: number) => number,
 *   setPriority: (pid: number, priority: number) => void,
 *   priorities?: { NORMAL: number, ABOVE_NORMAL: number },
 *   setTimer?: (run: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   log?: (line: string) => void,
 * }} deps
 */
function createSharePriority(deps) {
  const priorities = deps.priorities ?? DEFAULT_PRIORITIES;
  const setTimer = deps.setTimer ?? ((run, ms) => setInterval(run, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle));
  const log = deps.log ?? (() => {});
  const supported = deps.platform === "win32";

  /** pid -> the priority it had before this raised it. */
  const raised = new Map();
  let live = false;
  let timer = null;
  let boost = supported ? "idle" : "unsupported";

  function status() {
    return { live, boost, processes: raised.size };
  }

  function rescan() {
    let metrics = [];
    try {
      metrics = deps.listProcesses();
    } catch {
      return;
    }
    const wanted = new Set();
    let refused = 0;
    for (const metric of metrics) {
      if (!isShareProcess(metric)) {
        continue;
      }
      wanted.add(metric.pid);
      let current;
      try {
        current = deps.getPriority(metric.pid);
      } catch {
        continue;
      }
      if (raised.has(metric.pid)) {
        // Ours, and Chromium may have put it back.
        if (current > priorities.ABOVE_NORMAL) {
          try {
            deps.setPriority(metric.pid, priorities.ABOVE_NORMAL);
          } catch {
            refused += 1;
          }
        }
        continue;
      }
      // Already at or above the target (somebody, or the user, set it): not ours to touch.
      if (current <= priorities.ABOVE_NORMAL) {
        continue;
      }
      try {
        deps.setPriority(metric.pid, priorities.ABOVE_NORMAL);
        raised.set(metric.pid, current);
      } catch {
        refused += 1;
      }
    }
    // A process that is gone has nothing to restore.
    for (const pid of [...raised.keys()]) {
      if (!wanted.has(pid)) {
        raised.delete(pid);
      }
    }
    boost = raised.size > 0 ? "raised" : refused > 0 ? "failed" : boost;
  }

  function restore() {
    for (const [pid, previous] of raised) {
      try {
        deps.setPriority(pid, previous);
      } catch {
        // Exited since the last scan.
      }
    }
    const count = raised.size;
    raised.clear();
    return count;
  }

  return {
    /** A share is live. Returns what the shell did, for the page's diagnostics. */
    start() {
      if (!supported) {
        return status();
      }
      if (live) {
        return status();
      }
      live = true;
      boost = "idle";
      rescan();
      timer = setTimer(rescan, RESCAN_MS);
      log(`[pqp] share priority: ${boost}, ${raised.size} processes above normal`);
      return status();
    },

    /** The share is over (or the page that asked is gone). Safe to call any time. */
    stop() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      const wasLive = live;
      live = false;
      if (!supported) {
        return status();
      }
      const restored = restore();
      if (wasLive) {
        boost = "restored";
        log(`[pqp] share priority: restored ${restored} processes`);
      }
      return status();
    },

    status,
  };
}

module.exports = { createSharePriority, isShareProcess, DEFAULT_PRIORITIES, RESCAN_MS };

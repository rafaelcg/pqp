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
const RESTORE_RETRY_MS = 2_000;
const RESTORE_RETRIES = 5;

/**
 * The utility services the share depends on: the audio service (the
 * microphone), video capture, and the NETWORK service, which is where
 * Chromium's WebRTC UDP sockets live, so every packet of the share leaves
 * through it.
 *
 * `serviceName` is the non-localized name Electron reports (for example
 * `audio.mojom.AudioService`); `name` is localized for the built-in services,
 * so a Portuguese install says "Servico de audio". Both are matched, with the
 * accents stripped, so neither a locale nor a missing `serviceName` hides one.
 */
const SHARE_SERVICE = /audio|capture|captura|network|rede/;

/** @param {string} value */
function plain(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Which of `app.getAppMetrics()`'s entries are part of the share's pipeline.
 * The browser process (desktop capture), renderers ("Tab"), the GPU process,
 * and the utility services above. The crashpad handler and the rest stay where
 * they are.
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
      return SHARE_SERVICE.test(plain(`${metric.name ?? ""} ${metric.serviceName ?? ""}`));
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
  let retryTimer = null;
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
    // Read off what is true now: every tracked process exiting must not leave
    // the last scan's "raised" standing.
    boost = raised.size > 0 ? "raised" : refused > 0 ? "failed" : "idle";
  }

  /**
   * Put every raised process back. A write that fails on a process that is
   * still alive is KEPT for another try (an exited process is dropped), so a
   * transient refusal cannot leave something boosted for good.
   * @returns how many processes are still to be restored
   */
  function restore() {
    for (const [pid, previous] of [...raised]) {
      try {
        deps.setPriority(pid, previous);
        raised.delete(pid);
      } catch {
        let alive = true;
        try {
          deps.getPriority(pid);
        } catch {
          alive = false;
        }
        if (!alive) {
          raised.delete(pid);
        }
      }
    }
    return raised.size;
  }

  /** Retry a restore that did not finish, a few times, then give up loudly. */
  function scheduleRestoreRetry(attempt) {
    // One retry timer at a time: a second `stop()` while a restore is still
    // failing must replace it, not leave the first one running forever.
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    if (raised.size === 0 || attempt >= RESTORE_RETRIES || live) {
      if (raised.size > 0 && !live) {
        log(`[pqp] share priority: could not restore ${raised.size} processes`);
      }
      return;
    }
    retryTimer = setTimer(() => {
      clearTimer(retryTimer);
      retryTimer = null;
      if (live) {
        return;
      }
      restore();
      boost = raised.size > 0 ? "failed" : "restored";
      scheduleRestoreRetry(attempt + 1);
    }, RESTORE_RETRY_MS);
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
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
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
      // A stop with no share live and a retry already pending changes nothing:
      // it must neither replace that timer nor hand the restore a fresh budget
      // (repeated calls would otherwise keep it from ever giving up).
      if (!wasLive && retryTimer !== null) {
        return status();
      }
      const before = raised.size;
      const left = restore();
      if (wasLive) {
        boost = left > 0 ? "failed" : "restored";
        log(`[pqp] share priority: restored ${before - left} of ${before} processes`);
      }
      if (left > 0) {
        scheduleRestoreRetry(0);
      }
      return status();
    },

    status,
  };
}

module.exports = { createSharePriority, isShareProcess, DEFAULT_PRIORITIES, RESCAN_MS };

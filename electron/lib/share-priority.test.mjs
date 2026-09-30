import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createSharePriority, isShareProcess, DEFAULT_PRIORITIES } = require("./share-priority.js");

const NORMAL = DEFAULT_PRIORITIES.NORMAL;
const ABOVE = DEFAULT_PRIORITIES.ABOVE_NORMAL;

/** A fake operating system: a table of pids and their priorities, and the metrics Electron would list. */
function machine(initial) {
  const priorities = new Map(Object.entries(initial).map(([pid, p]) => [Number(pid), p]));
  const metrics = [
    { pid: 10, type: "Browser" },
    { pid: 11, type: "Tab" },
    { pid: 12, type: "GPU" },
    { pid: 13, type: "Utility", name: "Audio Service", serviceName: "audio.mojom.AudioService" },
    { pid: 14, type: "Utility", name: "Network Service", serviceName: "network.mojom.NetworkService" },
    { pid: 15, type: "Utility", name: "Video Capture", serviceName: "video_capture.mojom.VideoCaptureService" },
    { pid: 16, type: "Zygote" },
  ];
  const writes = [];
  const timers = [];
  let refuse = new Set();
  const deps = {
    platform: "win32",
    listProcesses: () => metrics.filter((m) => priorities.has(m.pid)),
    getPriority: (pid) => {
      if (!priorities.has(pid)) throw new Error("ESRCH");
      return priorities.get(pid);
    },
    setPriority: (pid, priority) => {
      if (!priorities.has(pid)) throw new Error("ESRCH");
      if (refuse.has(pid)) throw new Error("EPERM");
      writes.push([pid, priority]);
      priorities.set(pid, priority);
    },
    setTimer: (run) => {
      timers.push(run);
      return timers.length;
    },
    clearTimer: (handle) => {
      timers[handle - 1] = null;
    },
  };
  return {
    deps,
    priorities,
    writes,
    timers,
    metrics,
    refuse: (...pids) => {
      refuse = new Set(pids);
    },
    tick: () => timers.forEach((run) => run?.()),
  };
}

const ALL = { 10: NORMAL, 11: NORMAL, 12: NORMAL, 13: NORMAL, 14: NORMAL, 15: NORMAL, 16: NORMAL };

describe("isShareProcess", () => {
  it("picks the browser, renderers, the GPU process and the audio, capture and network services", () => {
    assert.equal(isShareProcess({ pid: 1, type: "Utility", serviceName: "network.mojom.NetworkService" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Browser" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Tab" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "GPU" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Utility", serviceName: "audio.mojom.AudioService" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Utility", name: "Video Capture" }), true);
  });

  it("finds a service by its localized name when there is no serviceName", () => {
    assert.equal(isShareProcess({ pid: 1, type: "Utility", name: "Servi\u00e7o de \u00e1udio" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Utility", name: "Captura de v\u00eddeo" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Utility", name: "Servi\u00e7o de rede" }), true);
  });

  it("leaves other services, helpers and nonsense alone", () => {
    assert.equal(isShareProcess({ pid: 1, type: "Utility", serviceName: "storage.mojom.StorageService" }), false);
    assert.equal(isShareProcess({ pid: 1, type: "Utility" }), false);
    assert.equal(isShareProcess({ pid: 1, type: "Zygote" }), false);
    assert.equal(isShareProcess({ pid: 0, type: "GPU" }), false);
    assert.equal(isShareProcess({ pid: 1.5, type: "GPU" }), false);
    assert.equal(isShareProcess(null), false);
  });
});

describe("createSharePriority", () => {
  it("raises the pipeline's processes to above normal and nothing else", () => {
    const os = machine(ALL);
    const priority = createSharePriority(os.deps);
    const status = priority.start();
    assert.deepEqual(status, { live: true, boost: "raised", processes: 6 });
    assert.deepEqual(
      os.writes.map(([pid]) => pid).sort((a, b) => a - b),
      [10, 11, 12, 13, 14, 15],
    );
    assert.ok(os.writes.every(([, p]) => p === ABOVE));
    // The zygote is where it was.
    assert.equal(os.priorities.get(16), NORMAL);
  });

  it("puts every process back where it was, and lets go of the timer", () => {
    const os = machine({ ...ALL, 11: 10 });
    const priority = createSharePriority(os.deps);
    priority.start();
    assert.equal(os.priorities.get(11), ABOVE);
    const status = priority.stop();
    assert.deepEqual(status, { live: false, boost: "restored", processes: 0 });
    // Its OWN previous value (below normal), not an assumed normal.
    assert.equal(os.priorities.get(11), 10);
    assert.equal(os.priorities.get(10), NORMAL);
    assert.equal(os.timers[0], null);
  });

  it("never lowers a process that already sits above the target, and does not restore it", () => {
    const os = machine({ ...ALL, 12: -14 });
    const priority = createSharePriority(os.deps);
    priority.start();
    assert.equal(os.priorities.get(12), -14);
    priority.stop();
    assert.equal(os.priorities.get(12), -14);
    assert.ok(!os.writes.some(([pid]) => pid === 12));
  });

  it("raises a process that appears mid-share and one Chromium dropped back", () => {
    const os = machine({ 10: NORMAL, 12: NORMAL });
    const priority = createSharePriority(os.deps);
    priority.start();
    assert.equal(priority.status().processes, 2);

    // A renderer respawns; the GPU process gets put back by Chromium.
    os.priorities.set(11, NORMAL);
    os.priorities.set(12, NORMAL);
    os.tick();

    assert.equal(os.priorities.get(11), ABOVE);
    assert.equal(os.priorities.get(12), ABOVE);
    assert.equal(priority.status().processes, 3);
    priority.stop();
    assert.equal(os.priorities.get(11), NORMAL);
  });

  it("forgets a process that exited, and skips it on restore", () => {
    const os = machine(ALL);
    const priority = createSharePriority(os.deps);
    priority.start();
    os.priorities.delete(11);
    os.tick();
    assert.equal(priority.status().processes, 5);
    assert.doesNotThrow(() => priority.stop());
  });

  it("reports a refusal instead of claiming a boost, and keeps the share alive", () => {
    const os = machine({ 10: NORMAL, 11: NORMAL });
    os.refuse(10, 11);
    const priority = createSharePriority(os.deps);
    assert.deepEqual(priority.start(), { live: true, boost: "failed", processes: 0 });
    assert.doesNotThrow(() => priority.stop());
  });

  it("keeps a failed restore and tries again, instead of leaving a process boosted for good", () => {
    const os = machine({ 10: NORMAL, 11: NORMAL });
    const priority = createSharePriority(os.deps);
    priority.start();
    os.refuse(11);
    const status = priority.stop();
    assert.deepEqual(status, { live: false, boost: "failed", processes: 1 });
    assert.equal(os.priorities.get(10), NORMAL);
    assert.equal(os.priorities.get(11), ABOVE);
    // The refusal clears; the retry timer finishes the job.
    os.refuse();
    os.tick();
    assert.equal(os.priorities.get(11), NORMAL);
    assert.deepEqual(priority.status(), { live: false, boost: "restored", processes: 0 });
  });

  it("keeps a single retry timer however many times stop is called while restoring fails", () => {
    const os = machine({ 10: NORMAL });
    const priority = createSharePriority(os.deps);
    priority.start();
    os.refuse(10);
    priority.stop();
    priority.stop();
    priority.stop();
    assert.equal(os.timers.filter(Boolean).length, 1);
    os.refuse();
    os.tick();
    assert.equal(os.timers.filter(Boolean).length, 0);
    assert.equal(os.priorities.get(10), NORMAL);
  });

  it("gives up after a few retries instead of retrying forever", () => {
    const os = machine({ 10: NORMAL });
    const priority = createSharePriority(os.deps);
    priority.start();
    os.refuse(10);
    priority.stop();
    for (let i = 0; i < 10; i += 1) {
      os.tick();
    }
    assert.equal(os.timers.filter(Boolean).length, 0);
    assert.equal(priority.status().boost, "failed");
  });

  it("drops a failed restore for a process that has exited", () => {
    const os = machine({ 10: NORMAL, 11: NORMAL });
    const priority = createSharePriority(os.deps);
    priority.start();
    os.refuse(11);
    os.priorities.delete(11);
    assert.deepEqual(priority.stop(), { live: false, boost: "restored", processes: 0 });
  });

  it("does not keep saying raised once every tracked process has exited", () => {
    const os = machine({ 10: NORMAL, 11: NORMAL });
    const priority = createSharePriority(os.deps);
    priority.start();
    os.priorities.clear();
    os.tick();
    assert.deepEqual(priority.status(), { live: true, boost: "idle", processes: 0 });
  });

  it("a new share cancels a pending restore retry", () => {
    const os = machine({ 10: NORMAL });
    const priority = createSharePriority(os.deps);
    priority.start();
    os.refuse(10);
    priority.stop();
    assert.equal(os.timers.filter(Boolean).length, 1);
    os.refuse();
    priority.start();
    assert.equal(priority.status().live, true);
    priority.stop();
  });

  it("does nothing outside Windows, where a normal user cannot raise priority", () => {
    for (const platform of ["darwin", "linux"]) {
      const os = machine(ALL);
      const priority = createSharePriority({ ...os.deps, platform });
      assert.deepEqual(priority.start(), { live: false, boost: "unsupported", processes: 0 });
      assert.deepEqual(priority.stop(), { live: false, boost: "unsupported", processes: 0 });
      assert.equal(os.writes.length, 0);
      assert.equal(os.timers.length, 0);
    }
  });

  it("starting twice does not raise twice or stack timers", () => {
    const os = machine(ALL);
    const priority = createSharePriority(os.deps);
    priority.start();
    const writes = os.writes.length;
    priority.start();
    assert.equal(os.writes.length, writes);
    assert.equal(os.timers.length, 1);
  });

  it("stopping when nothing is live is harmless", () => {
    const os = machine(ALL);
    const priority = createSharePriority(os.deps);
    assert.deepEqual(priority.stop(), { live: false, boost: "idle", processes: 0 });
    assert.equal(os.writes.length, 0);
  });

  it("survives a process list it cannot read", () => {
    const os = machine(ALL);
    const priority = createSharePriority({
      ...os.deps,
      listProcesses: () => {
        throw new Error("metrics unavailable");
      },
    });
    assert.doesNotThrow(() => priority.start());
    assert.equal(priority.status().processes, 0);
    priority.stop();
  });
});

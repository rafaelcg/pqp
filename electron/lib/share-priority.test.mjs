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
  it("picks the browser, renderers, the GPU process and the audio and capture services", () => {
    assert.equal(isShareProcess({ pid: 1, type: "Browser" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Tab" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "GPU" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Utility", serviceName: "audio.mojom.AudioService" }), true);
    assert.equal(isShareProcess({ pid: 1, type: "Utility", name: "Video Capture" }), true);
  });

  it("leaves the network service, helpers and nonsense alone", () => {
    assert.equal(isShareProcess({ pid: 1, type: "Utility", serviceName: "network.mojom.NetworkService" }), false);
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
    assert.deepEqual(status, { live: true, boost: "raised", processes: 5 });
    assert.deepEqual(
      os.writes.map(([pid]) => pid).sort((a, b) => a - b),
      [10, 11, 12, 13, 15],
    );
    assert.ok(os.writes.every(([, p]) => p === ABOVE));
    // The network service and the zygote are where they were.
    assert.equal(os.priorities.get(14), NORMAL);
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
    assert.equal(priority.status().processes, 4);
    assert.doesNotThrow(() => priority.stop());
  });

  it("reports a refusal instead of claiming a boost, and keeps the share alive", () => {
    const os = machine({ 10: NORMAL, 11: NORMAL });
    os.refuse(10, 11);
    const priority = createSharePriority(os.deps);
    assert.deepEqual(priority.start(), { live: true, boost: "failed", processes: 0 });
    assert.doesNotThrow(() => priority.stop());
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

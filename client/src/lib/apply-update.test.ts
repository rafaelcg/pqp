import { describe, expect, it } from "vitest";
import {
  STEP_TIMEOUT_MS,
  applyUpdate,
  type ApplyUpdateDeps,
} from "./apply-update";

/** A clock the test owns: `sleep` advances it, so a 15 s deadline costs no time. */
function harness(registration: Parameters<typeof makeDeps>[0]) {
  return makeDeps(registration);
}

type FakeWorker = { postMessage: (message: unknown) => void } | null;

function makeDeps(registration: {
  installing?: FakeWorker;
  waiting?: FakeWorker;
  /** Runs on `update()`: what a real browser does when it finds a new worker. */
  onUpdate?: (reg: { installing: FakeWorker; waiting: FakeWorker }) => void;
  /** Called on every poll, to let a worker "finish installing". */
  onPoll?: (reg: { installing: FakeWorker; waiting: FakeWorker }, polls: number) => void;
  updateHangs?: boolean;
  /**
   * What the controlling worker says it was built from; undefined answers null.
   * A function models a worker that takes over a beat after it activates.
   */
  workerBuild?: string | ((asked: number) => string);
  /** No worker controls the page. */
  uncontrolled?: boolean;
  offline?: boolean;
  updateRejects?: boolean;
  none?: boolean;
}) {
  const log: string[] = [];
  let now = 0;
  let polls = 0;
  let asked = 0;
  const reg = {
    installing: registration.installing ?? null,
    waiting: registration.waiting ?? null,
    update: async () => {
      log.push("update");
      if (registration.updateRejects) {
        throw new Error("offline");
      }
      if (registration.updateHangs) {
        return new Promise<void>(() => {});
      }
      registration.onUpdate?.(reg);
    },
  };
  const deps: ApplyUpdateDeps = {
    getRegistration: async () => (registration.none ? undefined : reg),
    controllerBuild: async () => {
      log.push("ask-worker");
      asked += 1;
      if (registration.uncontrolled) {
        return { controlled: false, build: null };
      }
      const build =
        typeof registration.workerBuild === "function"
          ? registration.workerBuild(asked)
          : (registration.workerBuild ?? null);
      return { controlled: true, build };
    },
    online: () => !registration.offline,
    deleteAllCaches: async () => {
      log.push("purge");
    },
    reload: () => {
      log.push("reload");
    },
    sleep: async (ms) => {
      now += ms;
      polls += 1;
      registration.onPoll?.(reg, polls);
    },
    // Fires at once only for an update check that hangs; otherwise never, which
    // is what a 15 s timer that has not elapsed yet looks like.
    timeout: (ms) =>
      registration.updateHangs
        ? Promise.resolve().then(() => {
            now += ms;
          })
        : new Promise<void>(() => {}),
    now: () => now,
  };
  return { deps, log, reg };
}

describe("applyUpdate", () => {
  it("reloads straight away when there is no service worker to wait for", async () => {
    const { deps, log } = harness({ none: true });
    expect(await applyUpdate(null, deps)).toBe("activated");
    expect(log).toEqual(["reload"]);
  });

  it("reloads once nothing is installing or waiting, without purging anything", async () => {
    const { deps, log } = harness({});
    expect(await applyUpdate(null, deps)).toBe("activated");
    expect(log).toEqual(["update", "reload"]);
  });

  it("lets a new worker finish installing before it reloads", async () => {
    const { deps, log, reg } = harness({
      onUpdate: (r) => {
        r.installing = { postMessage: () => {} };
      },
      onPoll: (r, polls) => {
        if (polls === 3) {
          r.installing = null;
        }
      },
    });
    expect(await applyUpdate(null, deps)).toBe("activated");
    expect(reg.installing).toBeNull();
    expect(log).toEqual(["update", "reload"]);
  });

  it("tells a waiting worker to take over, and reloads when it has", async () => {
    const messages: unknown[] = [];
    const { deps, log, reg } = harness({
      waiting: { postMessage: (m) => messages.push(m) },
      onPoll: (r, polls) => {
        if (polls === 2) {
          r.waiting = null;
        }
      },
    });
    expect(await applyUpdate(null, deps)).toBe("activated");
    expect(messages[0]).toEqual({ type: "SKIP_WAITING" });
    expect(reg.waiting).toBeNull();
    expect(log.at(-1)).toBe("reload");
    expect(log).not.toContain("purge");
  });

  it("purges the caches and reloads anyway when the worker never takes over", async () => {
    const { deps, log } = harness({
      waiting: { postMessage: () => {} },
    });
    expect(await applyUpdate(null, deps)).toBe("purged");
    expect(log).toEqual(["update", "purge", "reload"]);
  });

  it("does not wait forever on an update check that hangs", async () => {
    const { deps, log } = harness({ updateHangs: true, installing: { postMessage: () => {} } });
    expect(await applyUpdate(null, deps)).toBe("purged");
    expect(log).toEqual(["update", "purge", "reload"]);
  });

  it("does not call a failed update check 'activated' when it has no target to verify against", async () => {
    // The prompt path: a worker announced a waiting build, then the check
    // failed and nothing is waiting. Nothing says the active worker is current.
    const { deps, log } = harness({ updateRejects: true });
    expect(await applyUpdate(null, deps)).toBe("purged");
    expect(log).toEqual(["update", "purge", "reload"]);
  });

  it("keeps the caches offline: with no network they are the only copy of the app", async () => {
    const { deps, log } = harness({ updateRejects: true, offline: true });
    expect(await applyUpdate(null, deps)).toBe("offline");
    expect(log).toEqual(["update", "reload"]);
  });

  it("still trusts a worker that was waiting when the update check then failed", async () => {
    const { deps, log } = harness({
      waiting: { postMessage: () => {} },
      updateRejects: true,
      onPoll: (r, polls) => {
        if (polls === 1) {
          r.waiting = null;
        }
      },
    });
    expect(await applyUpdate(null, deps)).toBe("activated");
    expect(log.at(-1)).toBe("reload");
  });

  describe("with a target build to reach", () => {
    it("reloads when the active worker is that build", async () => {
      const { deps, log } = harness({ workerBuild: "def456" });
      expect(await applyUpdate("def456", deps)).toBe("activated");
      expect(log).toEqual(["update", "ask-worker", "reload"]);
    });

    it("waits for the new worker to take control of THIS page before it reloads", async () => {
      // `registration.active` is the new worker a beat before `clients.claim()`
      // makes it the controller; a reload in that beat is served by the old one.
      const { deps, log } = harness({
        workerBuild: (asked) => (asked < 3 ? "abc123" : "def456"),
      });
      expect(await applyUpdate("def456", deps)).toBe("activated");
      expect(log.filter((entry) => entry === "ask-worker")).toHaveLength(3);
      expect(log).not.toContain("purge");
      expect(log.at(-1)).toBe("reload");
    });

    it("has nothing to wait for when no worker controls the page", async () => {
      const { deps, log } = harness({ uncontrolled: true });
      expect(await applyUpdate("def456", deps)).toBe("activated");
      expect(log).not.toContain("purge");
    });

    it("purges when nothing was installing but the worker is an older build (a stale sw.js at the CDN)", async () => {
      const { deps, log } = harness({ workerBuild: "abc123" });
      expect(await applyUpdate("def456", deps)).toBe("purged");
      // It asks repeatedly (the new worker may still be taking over) and only
      // then gives up.
      expect(log[0]).toBe("update");
      expect(log.filter((entry) => entry === "ask-worker").length).toBeGreaterThan(1);
      expect(log.slice(-2)).toEqual(["purge", "reload"]);
    });

    it("purges when the worker cannot say which build it is (one from before it could)", async () => {
      const { deps, log } = harness({});
      expect(await applyUpdate("def456", deps)).toBe("purged");
      // It asks repeatedly (the new worker may still be taking over) and only
      // then gives up.
      expect(log[0]).toBe("update");
      expect(log.filter((entry) => entry === "ask-worker").length).toBeGreaterThan(1);
      expect(log.slice(-2)).toEqual(["purge", "reload"]);
    });

    it("has no worker to question when there is no registration, and just reloads", async () => {
      const { deps, log } = harness({ none: true });
      expect(await applyUpdate("def456", deps)).toBe("activated");
      expect(log).toEqual(["reload"]);
    });
  });

  it("reloads even when the purge fails: a failed purge is no worse than none", async () => {
    const { deps, log } = harness({ waiting: { postMessage: () => {} } });
    deps.deleteAllCaches = async () => {
      throw new Error("quota");
    };
    expect(await applyUpdate(null, deps)).toBe("purged");
    expect(log.at(-1)).toBe("reload");
  });

  it("gives up on the worker after the step timeout, not sooner", async () => {
    const seen: number[] = [];
    const { deps } = harness({
      waiting: { postMessage: () => {} },
      onPoll: () => {},
    });
    const realNow = deps.now;
    deps.now = () => {
      const value = realNow();
      seen.push(value);
      return value;
    };
    await applyUpdate(null, deps);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(STEP_TIMEOUT_MS);
  });
});

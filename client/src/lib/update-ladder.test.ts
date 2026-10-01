import { describe, expect, it } from "vitest";
import {
  BACKOFF_MS,
  LEAVE_WAIT_MS,
  LEVEL_TTL_MS,
  RUNG_BUDGET_MS,
  cacheBustedUrl,
  runUpdateLadder,
  withoutCacheBuster,
  type LadderDeps,
} from "./update-ladder";

type Rung = "apply" | "purge" | "unregister";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

/**
 * Fake page. `sleep` advances a clock the test owns, so 8-second waits cost
 * nothing. A rung "takes the page away" by setting `leaving`, which is what the
 * real `pagehide` listener does.
 */
function setup(
  behaviour: Partial<Record<Rung, "leaves" | "resolves" | "rejects" | "throws" | "hangs">> = {},
  over: { online?: boolean | (() => boolean); storage?: ReturnType<typeof memoryStorage> | null } = {},
) {
  let now = 1_000_000;
  let leaving = false;
  const log: string[] = [];
  const storage = over.storage === undefined ? memoryStorage() : over.storage;
  const run = (rung: Rung) => {
    log.push(rung);
    const how = behaviour[rung] ?? "resolves";
    if (how === "leaves") {
      leaving = true;
      return Promise.resolve();
    }
    if (how === "rejects") {
      return Promise.reject(new Error(`${rung} failed`));
    }
    if (how === "throws") {
      throw new Error(`${rung} threw`);
    }
    if (how === "hangs") {
      return new Promise<void>(() => {});
    }
    return Promise.resolve();
  };
  const deps: LadderDeps = {
    applyUpdate: () => run("apply"),
    purgeAndNavigate: () => run("purge"),
    unregisterPurgeAndNavigate: () => run("unregister"),
    online: () =>
      typeof over.online === "function" ? over.online() : (over.online ?? true),
    leaving: () => leaving,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    storage,
  };
  return { deps, log, storage };
}

describe("runUpdateLadder", () => {
  it("is done after the first rung when the page leaves", async () => {
    const t = setup({ apply: "leaves" });
    expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: true });
    expect(t.log).toEqual(["apply"]);
  });

  it("does not trust a resolved promise: a page that is still here is a rung that failed", async () => {
    const t = setup({ apply: "resolves", purge: "leaves" });
    expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: true });
    expect(t.log).toEqual(["apply", "purge"]);
  });

  it("goes on after a rung that rejects", async () => {
    const t = setup({ apply: "rejects", purge: "leaves" });
    expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: true });
    expect(t.log).toEqual(["apply", "purge"]);
  });

  it("goes on after a rung that throws", async () => {
    const t = setup({ apply: "throws", purge: "throws", unregister: "leaves" });
    expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: true });
    expect(t.log).toEqual(["apply", "purge", "unregister"]);
  });

  it("goes on after a rung that never settles, once its budget is spent", async () => {
    // The budget is a real timer inside the ladder; shrink the wait by faking it.
    const t = setup({ apply: "hangs", purge: "leaves" });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: true });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(t.log).toEqual(["apply", "purge"]);
  });

  it("reaches the last resort and reports failure when nothing makes the page leave", async () => {
    const t = setup({});
    expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: false, reason: "failed" });
    expect(t.log).toEqual(["apply", "purge", "unregister"]);
  });

  it("backs off between rungs, and waits to see the page leave after each", async () => {
    const t = setup({});
    const startedAt = 1_000_000;
    await runUpdateLadder("b2", t.deps);
    // Three leave-waits and the two pauses between rungs, none after the last.
    const clock = t.deps.now();
    expect(clock - startedAt).toBeGreaterThanOrEqual(3 * LEAVE_WAIT_MS + BACKOFF_MS[0]! + BACKOFF_MS[1]!);
  });

  it("answers offline at once and touches nothing", async () => {
    const t = setup({}, { online: false });
    expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: false, reason: "offline" });
    expect(t.log).toEqual([]);
  });

  it("stops and reports offline when the network goes away mid-way", async () => {
    let calls = 0;
    const t = setup({}, { online: () => ++calls <= 1 });
    expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: false, reason: "offline" });
    expect(t.log).toEqual(["apply"]);
  });

  describe("escalation across clicks", () => {
    it("starts the next click on a heavier rung than the last one used", async () => {
      const t = setup({ apply: "resolves", purge: "resolves", unregister: "resolves" });
      // Click 1 fails all the way down.
      expect((await runUpdateLadder("b2", t.deps)).ok).toBe(false);
      t.log.length = 0;
      // Click 2 does not repeat the rungs that already failed: it goes straight to the last resort.
      expect((await runUpdateLadder("b2", t.deps)).ok).toBe(false);
      expect(t.log).toEqual(["unregister"]);
    });

    it("remembers a partial walk: a click that got to the second rung starts on the third", async () => {
      const storage = memoryStorage();
      const t1 = setup({ purge: "leaves" }, { storage });
      await runUpdateLadder("b2", t1.deps);
      // The page left on rung 1 but the build is still stale on arrival.
      const t2 = setup({ unregister: "leaves" }, { storage });
      await runUpdateLadder("b2", t2.deps);
      expect(t2.log).toEqual(["unregister"]);
    });

    it("starts from the top for a different build", async () => {
      const storage = memoryStorage();
      await runUpdateLadder("b2", setup({}, { storage }).deps);
      const t = setup({ apply: "leaves" }, { storage });
      await runUpdateLadder("b3", t.deps);
      expect(t.log).toEqual(["apply"]);
    });

    it("starts from the top again once the remembered level is stale", async () => {
      const storage = memoryStorage();
      const first = setup({}, { storage });
      await runUpdateLadder("b2", first.deps);
      const t = setup({ apply: "leaves" }, { storage });
      // Time passes on the second fake page's own clock: age the stored entry instead.
      const key = [...storage.data.keys()][0]!;
      const stored = JSON.parse(storage.data.get(key)!);
      stored.at -= LEVEL_TTL_MS + 100_000;
      storage.data.set(key, JSON.stringify(stored));
      await runUpdateLadder("b2", t.deps);
      expect(t.log).toEqual(["apply"]);
    });

    it("works without storage: it just cannot remember", async () => {
      const t = setup({}, { storage: null });
      expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: false, reason: "failed" });
      expect(t.log).toEqual(["apply", "purge", "unregister"]);
    });

    it("works with storage that throws", async () => {
      const broken = {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
        data: new Map<string, string>(),
      };
      const t = setup({ apply: "leaves" }, { storage: broken });
      expect(await runUpdateLadder("b2", t.deps)).toEqual({ ok: true });
    });
  });

  it("has a rung budget shorter than the whole job, so a hung rung cannot hold the person for minutes", () => {
    expect(RUNG_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("the cache buster", () => {
  it("adds a query nothing has cached, keeping the path, other params and hash", () => {
    const url = cacheBustedUrl("https://pqp.gg/app/dm?x=1#frag", 1234);
    expect(url).toBe("https://pqp.gg/app/dm?x=1&_pqp=1234#frag");
  });

  it("replaces an earlier one instead of stacking them", () => {
    expect(cacheBustedUrl("https://pqp.gg/app?_pqp=1", 2)).toBe("https://pqp.gg/app?_pqp=2");
  });

  it("is removed again, and only when it is there", () => {
    expect(withoutCacheBuster("https://pqp.gg/app?x=1&_pqp=1234#frag")).toBe(
      "https://pqp.gg/app?x=1#frag",
    );
    expect(withoutCacheBuster("https://pqp.gg/app?_pqp=1")).toBe("https://pqp.gg/app");
    expect(withoutCacheBuster("https://pqp.gg/app?x=1")).toBeNull();
  });
});

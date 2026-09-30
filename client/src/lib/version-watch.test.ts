import { describe, expect, it } from "vitest";
import { NO_FORCE, type ForceConfig, type LatestBuild } from "./client-version";
import {
  MIN_GAP_MS,
  createVersionWatch,
  fetchLatestBuild,
} from "./version-watch";
import { FRESH_BUILD, type BuildStaleness } from "./update-prompt-state";

const running = { build: "abc123", builtAt: 1_000 };

function setup(over: {
  latest?: LatestBuild | null | (() => LatestBuild | null);
  force?: ForceConfig | (() => Promise<ForceConfig>);
  running?: { build: string; builtAt: number };
} = {}) {
  let clock = 1_000_000;
  const published: BuildStaleness[] = [];
  const calls = { latest: 0, force: 0, worker: 0 };
  const watch = createVersionWatch({
    running: over.running ?? running,
    fetchLatest: async () => {
      calls.latest += 1;
      const value = over.latest;
      return typeof value === "function" ? value() : (value ?? null);
    },
    fetchForceConfig: async () => {
      calls.force += 1;
      const value = over.force ?? NO_FORCE;
      return typeof value === "function" ? value() : value;
    },
    updateWorker: async () => {
      calls.worker += 1;
    },
    publish: (next) => published.push(next),
    now: () => clock,
  });
  return {
    watch,
    published,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createVersionWatch", () => {
  it("publishes fresh when the deployed build is the one running", async () => {
    const s = setup({ latest: { build: "abc123", builtAt: 1_000 } });
    await s.watch.check();
    expect(s.published).toEqual([FRESH_BUILD]);
  });

  it("never asks the API anything while up to date", async () => {
    const s = setup({ latest: { build: "abc123", builtAt: 1_000 } });
    await s.watch.check();
    expect(s.calls.force).toBe(0);
  });

  it("publishes stale, with the deployed build's age, when a newer build is out", async () => {
    const s = setup({ latest: { build: "def456", builtAt: 500_000 } });
    await s.watch.check();
    expect(s.published).toEqual([
      { stale: true, forced: false, latestBuild: "def456", since: 500_000 },
    ]);
    expect(s.calls.force).toBe(1);
  });

  it("uses the moment it first saw the build when the manifest carries no time", async () => {
    const s = setup({ latest: { build: "def456", builtAt: null } });
    await s.watch.check();
    expect(s.published[0]?.since).toBe(1_000_000);
    s.advance(MIN_GAP_MS * 5);
    await s.watch.check();
    // Still the first sighting, not the latest look.
    expect(s.published.at(-1)?.since).toBe(1_000_000);
  });

  it("is forced when the operator says so, and only when stale", async () => {
    const s = setup({
      latest: { build: "def456", builtAt: 500_000 },
      force: { forceUpdate: true, minBuiltAt: null },
    });
    await s.watch.check();
    expect(s.published[0]?.forced).toBe(true);
  });

  it("is forced by a minimum build time the running bundle predates", async () => {
    const s = setup({
      latest: { build: "def456", builtAt: 500_000 },
      force: { forceUpdate: false, minBuiltAt: 2_000 },
    });
    await s.watch.check();
    expect(s.published[0]?.forced).toBe(true);
  });

  it("reads a failed force lookup as no force, and still reports the stale build", async () => {
    const s = setup({
      latest: { build: "def456", builtAt: 500_000 },
      force: async () => {
        throw new Error("401");
      },
    });
    await s.watch.check();
    expect(s.published).toEqual([
      { stale: true, forced: false, latestBuild: "def456", since: 500_000 },
    ]);
  });

  it("publishes nothing when it could not read the manifest: not knowing is not 'current'", async () => {
    const s = setup({ latest: null });
    await s.watch.check();
    expect(s.published).toEqual([]);
  });

  it("goes back to fresh when the deployed build becomes the running one", async () => {
    let deployed: LatestBuild = { build: "def456", builtAt: 500_000 };
    const s = setup({ latest: () => deployed });
    await s.watch.check();
    deployed = { build: "abc123", builtAt: 1_000 };
    s.advance(MIN_GAP_MS);
    await s.watch.check();
    expect(s.published.at(-1)).toEqual(FRESH_BUILD);
  });

  it("asks the browser to look for a new worker every time it checks", async () => {
    const s = setup({ latest: { build: "abc123", builtAt: 1_000 } });
    await s.watch.check();
    expect(s.calls.worker).toBe(1);
  });

  it("is quiet for a dev build", async () => {
    const s = setup({
      running: { build: "dev", builtAt: 0 },
      latest: { build: "def456", builtAt: 500_000 },
    });
    await s.watch.check();
    expect(s.published).toEqual([FRESH_BUILD]);
  });

  describe("rate", () => {
    it("skips a check that comes within the minimum gap of the last", async () => {
      const s = setup({ latest: { build: "abc123", builtAt: 1_000 } });
      await s.watch.check();
      s.advance(MIN_GAP_MS - 1);
      await s.watch.check();
      expect(s.calls.latest).toBe(1);
      s.advance(1);
      await s.watch.check();
      expect(s.calls.latest).toBe(2);
    });

    it("lets a forced check through the gap (a new worker just took control)", async () => {
      const s = setup({ latest: { build: "abc123", builtAt: 1_000 } });
      await s.watch.check();
      await s.watch.check({ force: true });
      expect(s.calls.latest).toBe(2);
    });

    it("shares one request between overlapping checks", async () => {
      const s = setup({ latest: { build: "abc123", builtAt: 1_000 } });
      await Promise.all([
        s.watch.check({ force: true }),
        s.watch.check({ force: true }),
        s.watch.check({ force: true }),
      ]);
      expect(s.calls.latest).toBe(1);
    });
  });
});

describe("fetchLatestBuild", () => {
  function respond(body: string, init: { status?: number; type?: string } = {}) {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, options: RequestInit) => {
      seen.push({ url, init: options });
      return new Response(body, {
        status: init.status ?? 200,
        headers: { "content-type": init.type ?? "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it("reads the manifest past every cache: no-store, plus a query string a CDN keys on", async () => {
    const { fetchImpl, seen } = respond('{"build":"def456","builtAt":5}');
    expect(await fetchLatestBuild(fetchImpl, 1234)).toEqual({
      build: "def456",
      builtAt: 5,
    });
    expect(seen[0]?.url).toBe("/version.json?t=1234");
    expect(seen[0]?.init.cache).toBe("no-store");
  });

  it("answers null for the SPA shell an old deploy serves at this path", async () => {
    const { fetchImpl } = respond("<!doctype html><html></html>", { type: "text/html" });
    expect(await fetchLatestBuild(fetchImpl)).toBeNull();
  });

  it("answers null for an error status and for a network failure", async () => {
    const { fetchImpl } = respond("{}", { status: 503 });
    expect(await fetchLatestBuild(fetchImpl)).toBeNull();
    const failing = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await fetchLatestBuild(failing)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { checkWithRetry } from "../../scripts/precache-retry.mjs";

/** A fake clock: `sleep` advances `now`, so nothing really waits. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("checkWithRetry (the precache gate)", () => {
  it("passes with no retry when every entry answers 200", async () => {
    const c = clock();
    const calls: string[] = [];
    const r = await checkWithRetry({
      paths: ["a.js", "b.js"],
      statusOf: async (p) => (calls.push(p), 200),
      ...c,
    });
    expect(r.failed.size).toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.recovered).toBe(0);
    expect(calls).toEqual(["a.js", "b.js"]);
  });

  it("recovers entries that were still propagating and re-checks only those", async () => {
    const c = clock();
    const seen = new Map<string, number>();
    const r = await checkWithRetry({
      paths: ["ok.js", "late.js", "later.js"],
      statusOf: async (p) => {
        const n = (seen.get(p) ?? 0) + 1;
        seen.set(p, n);
        if (p === "late.js") return n >= 2 ? 200 : 404;
        if (p === "later.js") return n >= 4 ? 200 : 404;
        return 200;
      },
      windowMs: 120_000,
      intervalMs: 10_000,
      ...c,
    });
    expect(r.failed.size).toBe(0);
    expect(r.firstFailures).toBe(2);
    expect(r.recovered).toBe(2);
    expect(r.elapsedMs).toBe(30_000);
    expect(seen.get("ok.js")).toBe(1);
    expect(seen.get("late.js")).toBe(2);
    expect(seen.get("later.js")).toBe(4);
  });

  it("still fails an entry that never answers 200, after the whole window", async () => {
    const c = clock();
    const r = await checkWithRetry({
      paths: ["gone.html", "fine.js"],
      statusOf: async (p) => (p === "gone.html" ? 404 : 200),
      windowMs: 120_000,
      intervalMs: 10_000,
      ...c,
    });
    expect([...r.failed]).toEqual([["gone.html", 404]]);
    expect(r.recovered).toBe(0);
    expect(r.attempts).toBe(13);
    expect(r.elapsedMs).toBe(120_000);
  });

  it("keeps a persistent redirect or network error red", async () => {
    const c = clock();
    const r = await checkWithRetry({
      paths: ["x.html", "y.js"],
      statusOf: async (p) => (p === "x.html" ? 308 : "ECONNRESET"),
      windowMs: 30_000,
      intervalMs: 10_000,
      ...c,
    });
    expect(Object.fromEntries(r.failed)).toEqual({
      "x.html": 308,
      "y.js": "ECONNRESET",
    });
  });

  it("never polls faster than once a second, even with a zero interval", async () => {
    const c = clock();
    let calls = 0;
    await checkWithRetry({
      paths: ["a.js"],
      statusOf: async () => (calls++, 404),
      windowMs: 10_000,
      intervalMs: 0,
      ...c,
    });
    expect(calls).toBe(11);
  });

  it("does not retry at all with a zero window", async () => {
    const c = clock();
    let calls = 0;
    const r = await checkWithRetry({
      paths: ["a.js"],
      statusOf: async () => (calls++, 404),
      windowMs: 0,
      ...c,
    });
    expect(calls).toBe(1);
    expect(r.failed.size).toBe(1);
  });
});

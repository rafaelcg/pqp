import { describe, expect, it, vi } from "vitest";
import { POST_COMMIT_RETRY_DELAYS_MS, retryAfterCommit } from "./post-commit-retry.js";

const noSleep = async () => {};

describe("retryAfterCommit", () => {
  it("keeps trying until an attempt succeeds", async () => {
    let calls = 0;
    const ok = await retryAfterCommit(
      async () => {
        calls += 1;
        if (calls < 6) throw new Error("database_unavailable");
      },
      { event: "test.failed", fields: {}, sleep: noSleep },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(6);
  });

  it("gives up after the last delay, without throwing", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("down");
    });
    const ok = await retryAfterCommit(attempt, { event: "test.failed", fields: {}, sleep: noSleep });
    expect(ok).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(POST_COMMIT_RETRY_DELAYS_MS.length);
  });

  it("waits each delay in order before its attempt", async () => {
    const waited: number[] = [];
    await retryAfterCommit(
      async () => {
        throw new Error("down");
      },
      {
        event: "test.failed",
        fields: {},
        delaysMs: [10, 20, 30],
        sleep: async (ms) => {
          waited.push(ms);
        },
      },
    );
    expect(waited).toEqual([10, 20, 30]);
  });

  it("outlasts a one minute database outage", () => {
    const total = POST_COMMIT_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(90_000);
  });
});

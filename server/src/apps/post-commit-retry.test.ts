import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POST_COMMIT_RETRY_DELAYS_MS,
  POST_COMMIT_RETRY_MAX_PENDING,
  pendingPostCommitRetries,
  resetPostCommitRetriesForTests,
  retryAfterCommit,
} from "./post-commit-retry.js";

const noSleep = async () => {};
let n = 0;
const base = () => ({
  event: "test.failed",
  key: `test:${(n += 1)}`,
  fields: {},
  sleep: noSleep,
  databaseDown: () => false,
});

afterEach(() => resetPostCommitRetriesForTests());

describe("retryAfterCommit", () => {
  it("keeps trying until an attempt succeeds", async () => {
    let calls = 0;
    const ok = await retryAfterCommit(async () => {
      calls += 1;
      if (calls < 6) throw new Error("database_unavailable");
    }, base());
    expect(ok).toBe(true);
    expect(calls).toBe(6);
    expect(pendingPostCommitRetries()).toBe(0);
  });

  it("gives up after the last delay, without throwing", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await retryAfterCommit(attempt, base())).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(POST_COMMIT_RETRY_DELAYS_MS.length);
  });

  it("jitters each delay by at most a quarter either way", async () => {
    const waited: number[] = [];
    for (const random of [() => 0, () => 0.999]) {
      await retryAfterCommit(
        async () => {
          throw new Error("down");
        },
        { ...base(), delaysMs: [1000], random, sleep: async (ms) => void waited.push(ms) },
      );
    }
    expect(waited).toEqual([750, 1250]);
  });

  it("spends no attempt while the database breaker is open, and goes on once it closes", async () => {
    let down = true;
    let polls = 0;
    const attempt = vi.fn(async () => {});
    const ok = await retryAfterCommit(attempt, {
      ...base(),
      delaysMs: [10],
      databaseDown: () => down,
      sleep: async () => {
        polls += 1;
        if (polls > 5) down = false;
      },
    });
    expect(ok).toBe(true);
    expect(attempt).toHaveBeenCalledOnce();
    expect(polls).toBeGreaterThan(5);
  });

  it("gives up past its horizon when the database never comes back", async () => {
    let clock = 0;
    const attempt = vi.fn(async () => {});
    const ok = await retryAfterCommit(attempt, {
      ...base(),
      horizonMs: 60_000,
      now: () => clock,
      databaseDown: () => true,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(ok).toBe(false);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("does not start a second retry for a key already waiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = vi.fn(async () => {});
    const options = { ...base(), sleep: () => gate };
    const running = retryAfterCommit(first, options);
    const second = vi.fn(async () => {});
    expect(await retryAfterCommit(second, options)).toBe(false);
    release();
    expect(await running).toBe(true);
    expect(second).not.toHaveBeenCalled();
  });

  it("keeps at most POST_COMMIT_RETRY_MAX_PENDING waiting at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = Array.from({ length: POST_COMMIT_RETRY_MAX_PENDING }, () =>
      retryAfterCommit(async () => {}, { ...base(), sleep: () => gate }),
    );
    expect(pendingPostCommitRetries()).toBe(POST_COMMIT_RETRY_MAX_PENDING);
    const extra = vi.fn(async () => {});
    expect(await retryAfterCommit(extra, base())).toBe(false);
    expect(extra).not.toHaveBeenCalled();
    release();
    await Promise.all(held);
    expect(pendingPostCommitRetries()).toBe(0);
  });
});

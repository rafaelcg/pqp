import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two asks for the config can be in flight at once (the first read and a focus
 * refresh) and the network may answer them in either order. Only the newest ask
 * may write, or a slow old `true` lands after the operator's flip to `false`.
 */

const asks = vi.hoisted(() => ({
  pending: [] as { resolve: (answer: unknown) => void; reject: (error: unknown) => void }[],
}));

vi.mock("@/lib/push", () => ({
  getPushConfig: () =>
    new Promise((resolve, reject) => {
      asks.pending.push({ resolve, reject });
    }),
}));
vi.mock("@/lib/config-refresh", () => ({ onConfigRefresh: () => () => {} }));

const {
  isNotifyOpenChannelEnabled,
  loadNotifyConfig,
  startNotifyConfig,
  setNotifyConfigForTests,
} = await import("./notify-config");

beforeEach(() => {
  asks.pending.length = 0;
  setNotifyConfigForTests(null);
});

describe("startNotifyConfig", () => {
  it("goes back to off on teardown, and drops an ask still in flight", async () => {
    const stop = startNotifyConfig();
    asks.pending[0]!.resolve({ notifyOpenChannel: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(isNotifyOpenChannelEnabled()).toBe(true);
    stop();
    expect(isNotifyOpenChannelEnabled()).toBe(false);

    const next = startNotifyConfig();
    next();
    asks.pending[1]!.resolve({ notifyOpenChannel: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(isNotifyOpenChannelEnabled()).toBe(false);
  });
});

describe("loadNotifyConfig", () => {
  it("starts off and turns on from an explicit true", async () => {
    expect(isNotifyOpenChannelEnabled()).toBe(false);
    const done = loadNotifyConfig();
    asks.pending[0]!.resolve({ notifyOpenChannel: true });
    await done;
    expect(isNotifyOpenChannelEnabled()).toBe(true);
  });

  it("an older answer that arrives after a newer one is dropped", async () => {
    const first = loadNotifyConfig();
    const second = loadNotifyConfig();
    asks.pending[1]!.resolve({ notifyOpenChannel: false });
    await second;
    asks.pending[0]!.resolve({ notifyOpenChannel: true });
    await first;
    expect(isNotifyOpenChannelEnabled()).toBe(false);
  });

  it("the newer answer still wins when the older one arrives first", async () => {
    const first = loadNotifyConfig();
    const second = loadNotifyConfig();
    asks.pending[0]!.resolve({ notifyOpenChannel: true });
    await first;
    asks.pending[1]!.resolve({ notifyOpenChannel: false });
    await second;
    expect(isNotifyOpenChannelEnabled()).toBe(false);
  });

  it("an older answer still counts when the newer ask failed", async () => {
    const first = loadNotifyConfig();
    const second = loadNotifyConfig();
    asks.pending[1]!.reject(new Error("offline"));
    await second;
    asks.pending[0]!.resolve({ notifyOpenChannel: true });
    await first;
    expect(isNotifyOpenChannelEnabled()).toBe(true);
  });

  it("a failed ask keeps the last answer", async () => {
    setNotifyConfigForTests({ notifyOpenChannel: true });
    const done = loadNotifyConfig();
    asks.pending[0]!.reject(new Error("offline"));
    await done;
    expect(isNotifyOpenChannelEnabled()).toBe(true);
  });
});

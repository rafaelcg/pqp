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
  isDesktopNotifyDefaultOnEnabled,
  loadNotifyDefaultsConfig,
  setDesktopNotifyDefaultOnForTests,
} = await import("./notify-defaults-config");

beforeEach(() => {
  asks.pending.length = 0;
  setDesktopNotifyDefaultOnForTests(false);
});

describe("loadNotifyDefaultsConfig", () => {
  it("starts off and turns on from an explicit true", async () => {
    expect(isDesktopNotifyDefaultOnEnabled()).toBe(false);
    const done = loadNotifyDefaultsConfig();
    asks.pending[0]!.resolve({ desktopNotifyDefaultOn: true });
    await done;
    expect(isDesktopNotifyDefaultOnEnabled()).toBe(true);
  });

  it("an older answer that arrives after a newer one is dropped", async () => {
    const first = loadNotifyDefaultsConfig();
    const second = loadNotifyDefaultsConfig();
    asks.pending[1]!.resolve({ desktopNotifyDefaultOn: false });
    await second;
    asks.pending[0]!.resolve({ desktopNotifyDefaultOn: true });
    await first;
    expect(isDesktopNotifyDefaultOnEnabled()).toBe(false);
  });

  it("the newer answer still wins when the older one arrives first", async () => {
    const first = loadNotifyDefaultsConfig();
    const second = loadNotifyDefaultsConfig();
    asks.pending[0]!.resolve({ desktopNotifyDefaultOn: true });
    await first;
    asks.pending[1]!.resolve({ desktopNotifyDefaultOn: false });
    await second;
    expect(isDesktopNotifyDefaultOnEnabled()).toBe(false);
  });

  it("a failed ask keeps the last answer", async () => {
    setDesktopNotifyDefaultOnForTests(true);
    const done = loadNotifyDefaultsConfig();
    asks.pending[0]!.reject(new Error("offline"));
    await done;
    expect(isDesktopNotifyDefaultOnEnabled()).toBe(true);
  });
});

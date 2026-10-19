import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audience = vi.hoisted(() => ({ getChannelAudience: vi.fn() }));
const sockets = vi.hoisted(() => ({ list: [] as Array<{ socket: unknown; user: { id: string } }> }));

vi.mock("../services/servers.js", () => ({ getChannelAudience: audience.getChannelAudience }));
vi.mock("./sockets.js", () => ({
  hasAuthenticatedSockets: () => sockets.list.length > 0,
  forEachAuthenticatedSocket: (callback: (socket: unknown, user: { id: string }) => void) => {
    for (const entry of sockets.list) callback(entry.socket, entry.user);
  },
}));

const { announceAppEnded, resetAppsWsForTests } = await import("./apps.js");
const { resetPostCommitRetriesForTests } = await import("../apps/post-commit-retry.js");

function fakeSocket() {
  return { readyState: 1, send: vi.fn() };
}

const frame = {
  type: "app-ended" as const,
  sessionId: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  reason: "host" as const,
  summary: { participants: 1, durationSeconds: 5, result: null },
};

describe("app-ended to the channel's viewers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAppsWsForTests();
    resetPostCommitRetriesForTests();
    audience.getChannelAudience.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    sockets.list = [];
  });

  it("still reaches a viewer when the audience lookup fails for longer than three quick tries", async () => {
    const viewer = fakeSocket();
    sockets.list = [{ socket: viewer, user: { id: "viewer" } }];
    let calls = 0;
    audience.getChannelAudience.mockImplementation(async () => {
      calls += 1;
      if (calls <= 4) throw new Error("database_unavailable");
      return new Set(["viewer"]);
    });

    await announceAppEnded(frame as never);
    expect(viewer.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(5);
    expect(viewer.send).toHaveBeenCalledOnce();
  });

  it("does not hold the end answer while the lookup is retried", async () => {
    sockets.list = [{ socket: fakeSocket(), user: { id: "viewer" } }];
    audience.getChannelAudience.mockRejectedValue(new Error("down"));
    let settled = false;
    void announceAppEnded(frame as never).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(200_000);
  });

  it("tells nobody else about a channel that no longer exists, and does not retry it", async () => {
    const viewer = fakeSocket();
    sockets.list = [{ socket: viewer, user: { id: "viewer" } }];
    audience.getChannelAudience.mockResolvedValue(null);
    await announceAppEnded(frame as never);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(audience.getChannelAudience).toHaveBeenCalledOnce();
    expect(viewer.send).not.toHaveBeenCalled();
  });
});

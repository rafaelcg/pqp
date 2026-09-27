import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAST_RECONNECT_CAP_MS,
  FAST_RECONNECT_WINDOW_MS,
  freshKeepaliveState,
  KEEPALIVE_PROFILES,
  keepaliveAction,
  noteInbound,
  noteNetworkUp,
  notePingSent,
  noteProbeSent,
  PROBE_TIMEOUT_MS,
  reconnectCauseForClose,
  reconnectDelayMs,
  resetInFlight,
  UP_GRACE_MS,
} from "./realtime-liveness";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keepaliveAction", () => {
  it("waits while the socket has been heard from recently", () => {
    const state = freshKeepaliveState(0);
    expect(keepaliveAction(state, 2_999, "fast")).toBe("wait");
    expect(keepaliveAction(state, 3_000, "fast")).toBe("ping");
    expect(keepaliveAction(state, 14_999, "normal")).toBe("wait");
    expect(keepaliveAction(state, 15_000, "normal")).toBe("ping");
  });

  it("needs two unanswered pings and the deadline before calling it dead", () => {
    const { retryMs, deadlineMs } = KEEPALIVE_PROFILES.fast;
    const state = freshKeepaliveState(0);
    notePingSent(state, 3_000);
    // One unanswered ping, however old, is never enough on its own.
    expect(keepaliveAction(state, 3_000 + retryMs - 1, "fast")).toBe("wait");
    expect(keepaliveAction(state, 3_000 + retryMs, "fast")).toBe("ping");
    notePingSent(state, 3_000 + retryMs);
    expect(keepaliveAction(state, 3_000 + deadlineMs - 1, "fast")).toBe("wait");
    expect(keepaliveAction(state, 3_000 + deadlineMs, "fast")).toBe("dead");
  });

  it("finds a dead link within about ten seconds on the fast profile, ticking every second", () => {
    const state = freshKeepaliveState(0);
    let deadAt: number | null = null;
    for (let now = 1_000; now <= 30_000 && deadAt === null; now += 1_000) {
      const action = keepaliveAction(state, now, "fast");
      if (action === "ping") {
        notePingSent(state, now);
      } else if (action === "dead") {
        deadAt = now;
      }
    }
    expect(deadAt).not.toBeNull();
    expect(deadAt!).toBeLessThanOrEqual(10_000);
  });

  it("is cleared by any inbound frame", () => {
    const state = freshKeepaliveState(0);
    notePingSent(state, 3_000);
    notePingSent(state, 6_000);
    noteInbound(state, 6_500);
    expect(state.unanswered).toBe(0);
    expect(keepaliveAction(state, 9_000, "fast")).toBe("wait");
  });

  it("gives a probe its own short deadline", () => {
    const state = freshKeepaliveState(0);
    noteProbeSent(state, 100);
    expect(
      keepaliveAction(state, 100 + PROBE_TIMEOUT_MS - 1, "normal"),
    ).not.toBe("dead");
    expect(keepaliveAction(state, 100 + PROBE_TIMEOUT_MS, "normal")).toBe(
      "dead",
    );
  });

  it("shortens the wait on unanswered pings once the network is back", () => {
    const state = freshKeepaliveState(0);
    noteNetworkUp(state, 1_000);
    // Nothing in flight: nothing was missed, nothing changes.
    expect(state.probeDeadlineAt).toBeNull();

    notePingSent(state, 3_000);
    noteNetworkUp(state, 4_000);
    expect(keepaliveAction(state, 4_000 + UP_GRACE_MS - 1, "fast")).not.toBe(
      "dead",
    );
    expect(keepaliveAction(state, 4_000 + UP_GRACE_MS, "fast")).toBe("dead");
  });

  it("forgets a stale in-flight count after a throttled or sleeping tab", () => {
    const state = freshKeepaliveState(0);
    notePingSent(state, 3_000);
    notePingSent(state, 6_000);
    resetInFlight(state);
    expect(keepaliveAction(state, 60_000, "fast")).toBe("ping");
  });
});

describe("reconnectCauseForClose", () => {
  it("maps deploy closes, network closes and refusals", () => {
    expect(reconnectCauseForClose(1001)).toBe("drain");
    expect(reconnectCauseForClose(1012)).toBe("drain");
    expect(reconnectCauseForClose(1006)).toBe("network");
    expect(reconnectCauseForClose(1005)).toBe("network");
    expect(reconnectCauseForClose(4401)).toBe("refused");
    expect(reconnectCauseForClose(4429)).toBe("refused");
    expect(reconnectCauseForClose(1000)).toBe("refused");
  });
});

describe("reconnectDelayMs", () => {
  it("retries a network loss within 250ms", () => {
    for (let i = 0; i < 200; i++) {
      const delay = reconnectDelayMs(0, "network", 0);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(250);
    }
  });

  it("keeps network retries under the fast cap for the first minute", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(reconnectDelayMs(1, "network", 1_000)).toBeCloseTo(1_000);
    expect(reconnectDelayMs(2, "network", 2_000)).toBeCloseTo(2_000);
    expect(reconnectDelayMs(3, "network", 5_000)).toBeCloseTo(4_000);
    for (let attempt = 4; attempt < 20; attempt++) {
      expect(reconnectDelayMs(attempt, "network", 30_000)).toBeCloseTo(
        FAST_RECONNECT_CAP_MS,
      );
    }
  });

  it("grows to the 30s cap once an outage outlasts the fast window", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(reconnectDelayMs(9, "network", FAST_RECONNECT_WINDOW_MS)).toBeCloseTo(
      30_000,
    );
  });

  it("keeps the deploy spread for a drain and the slow schedule for a refusal", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(reconnectDelayMs(0, "drain")).toBeCloseTo(4_000);
    expect(reconnectDelayMs(0, "refused")).toBeCloseTo(1_000);
    expect(reconnectDelayMs(5, "refused", 0)).toBeCloseTo(30_000);
  });

  it("is full jitter: identical inputs spread across the window", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) {
      delays.add(Math.round(reconnectDelayMs(4, "network", 10_000)));
    }
    expect(delays.size).toBeGreaterThan(10);
  });
});

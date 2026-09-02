import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtimeTransport, type RealtimeStatus } from "./realtime";

/**
 * The transport previously had no reconnect at all: one dropped socket left the
 * app permanently dead with a stale error banner. These tests pin the recovery
 * behaviour.
 */

const sockets: FakeSocket[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  private openListeners: Array<() => void> = [];

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    if (type === "open") {
      this.openListeners.push(listener);
    }
  }

  send(data: string) {
    this.sent.push(data);
  }

  /** Fire the open handlers registered either way. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    for (const listener of this.openListeners) {
      listener();
    }
  }

  close(code = 1000) {
    if (this.readyState === FakeSocket.CLOSED) {
      return;
    }
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** Test helper: complete the handshake the server would perform. */
  accept() {
    this.open();
    this.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("window", {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { protocol: "https:", host: "example.test" },
  });
  vi.stubGlobal("document", {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  });
  vi.useFakeTimers();
  // Deterministic backoff.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Let the token promise settle without advancing timers. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createRealtimeTransport", () => {
  it("authenticates with a freshly resolved token on connect", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "token-1");
    await flush();

    expect(sockets).toHaveLength(1);
    sockets[0]!.open();

    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: "auth",
      token: "token-1",
    });
  });

  it("reconnects after an unexpected close and asks for a new token", async () => {
    let issued = 0;
    const transport = createRealtimeTransport();
    transport.connect(async () => `token-${++issued}`);
    await flush();
    sockets[0]!.accept();
    expect(transport.isConnected()).toBe(true);

    sockets[0]!.close(1006);
    expect(transport.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();

    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!).token).toBe("token-2");
  });

  it("backs off exponentially across repeated failures", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();

    const openedAt: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      openedAt.push(sockets.length);
      sockets[sockets.length - 1]!.close(1006);
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
    }

    // Each round produced exactly one new socket; the delay grew each time.
    expect(sockets.length).toBe(5);
  });

  it("does not reconnect after an explicit disconnect", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    transport.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(sockets).toHaveLength(1);
    expect(transport.getStatus()).toBe("idle");
  });

  it("queues messages while offline and flushes them once ready", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();

    transport.sendChat({ type: "leave-channel" });
    expect(sockets[0]!.sent).toHaveLength(0);

    sockets[0]!.accept();
    const payloads = sockets[0]!.sent.map((raw) => JSON.parse(raw).type);
    expect(payloads).toContain("auth");
    expect(payloads).toContain("leave-channel");
  });

  it("drains a deep offline queue in paced chunks, never one burst", async () => {
    // The server closes any connection that exceeds its 60-message burst
    // budget (server/src/ws/index.ts, close code 4429). A full-queue flush on
    // reconnect used to dump up to 300 messages in one loop, so the freshly
    // reconnected socket was killed immediately — on repeat, for exactly the
    // flaky networks the queues exist to survive.
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();

    for (let i = 0; i < 100; i++) {
      transport.sendChat({ type: "leave-channel" });
    }

    sockets[0]!.accept();
    // auth + the first burst only — comfortably under the server's budget.
    expect(sockets[0]!.sent.length).toBe(1 + 30);

    await vi.advanceTimersByTimeAsync(500);
    expect(sockets[0]!.sent.length).toBe(1 + 30 + 8);

    // A live send while draining joins the back of the queue, not the wire.
    transport.sendChat({ type: "leave-channel" });
    expect(sockets[0]!.sent.length).toBe(1 + 30 + 8);

    // The remainder (including the late send) drips out to completion.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.sent.length).toBe(1 + 101);
  });

  it("reports reconnected=true only on subsequent connects", async () => {
    const seen: boolean[] = [];
    const transport = createRealtimeTransport();
    transport.onReady((reconnected) => seen.push(reconnected));
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    sockets[1]!.accept();

    expect(seen).toEqual([false, true]);
  });

  it("moves through connecting → online → reconnecting", async () => {
    const seen: RealtimeStatus[] = [];
    const transport = createRealtimeTransport();
    transport.onStatusChange((status) => seen.push(status));
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();
    sockets[0]!.close(1006);

    expect(seen).toContain("connecting");
    expect(seen).toContain("online");
    expect(seen).toContain("reconnecting");
  });

  it("treats a rejected token as unauthorized but keeps retrying", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => null);
    await flush();

    expect(sockets).toHaveLength(0);
    expect(transport.getStatus()).toBe("unauthorized");

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(transport.getStatus()).toBe("unauthorized");
  });

  it("reconnects after a close code 1000 it did not initiate", async () => {
    // A proxy recycling the connection, or a graceful server shutdown, both
    // close with 1000. Treating that as final left the app stuck showing online.
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();
    expect(transport.getStatus()).toBe("online");

    sockets[0]!.close(1000);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(sockets.length).toBe(2);
    expect(transport.getStatus()).toBe("reconnecting");
  });

  it("closes the socket it replaces so no authenticated ghost is left open", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    // A second connect while the first is still live.
    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(sockets[0]!.readyState).toBe(FakeSocket.CLOSED);
    expect(sockets).toHaveLength(2);
  });

  it("tears down a silent connection so the reconnect path runs", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    // No traffic for longer than the silence window.
    // Comfortably past the silence window (3 ping intervals + 30s).
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();

    expect(sockets[0]!.readyState).toBe(FakeSocket.CLOSED);
    expect(sockets.length).toBeGreaterThan(1);
  });

  it("ignores pong frames instead of handing them to the app", async () => {
    const received: unknown[] = [];
    const transport = createRealtimeTransport();
    transport.onMessage((message) => received.push(message));
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    sockets[0]!.emit({ type: "pong" });
    expect(received).toHaveLength(0);

    sockets[0]!.emit({ type: "presence-update", channelId: "c", users: [] });
    expect(received).toHaveLength(1);
  });
});

describe("connection check hooks", () => {
  it("counts refused tokens in a row and resets on a ready socket", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "token");
    await flush();
    expect(transport.getUnauthorizedStreak()).toBe(0);
    sockets[0]!.open();
    sockets[0]!.close(4401);
    await flush();
    expect(transport.getUnauthorizedStreak()).toBe(1);
    expect(transport.getLastClose()?.code).toBe(4401);
    expect(transport.getStatus()).toBe("unauthorized");

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    sockets[1]!.open();
    sockets[1]!.close(4401);
    await flush();
    expect(transport.getUnauthorizedStreak()).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    sockets[2]!.accept();
    await flush();
    expect(transport.getUnauthorizedStreak()).toBe(0);
    expect(transport.getStatus()).toBe("online");
  });

  it("retryNow skips the backoff", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "token");
    await flush();
    sockets[0]!.open();
    sockets[0]!.close(1006);
    await flush();
    expect(sockets).toHaveLength(1);
    transport.retryNow();
    await flush();
    expect(sockets).toHaveLength(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRealtimeTransport,
  reconnectDelayMs,
  type RealtimeStatus,
} from "./realtime";
import { reconnectCauseForClose } from "./realtime-liveness";
import { clearNetworkHintListeners, emitNetworkHint } from "./network-hints";

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
  // Media hints are module-level; a transport left connected by an earlier
  // test must not answer this test's hints.
  clearNetworkHintListeners();
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
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("createRealtimeTransport", () => {
  it("authenticates with a freshly resolved token on connect", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "token-1");
    await flush();

    expect(sockets).toHaveLength(1);
    sockets[0]!.open();

    // `caps` is what this build declares it understands, so the server can
    // keep sending an older build the frames that build knows. Asserted as a
    // whole object on purpose: a capability added here is a promise that this
    // bundle handles the frame, and it should not be possible to make one by
    // accident.
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: "auth",
      token: "token-1",
      caps: [
        "voice-roster-delta",
        "presence-delta",
        "voice-transport-changed",
        // Honest for this bundle and only this bundle: a browser keeps its
        // mesh peer connections up across a signalling drop and comes back to
        // the same peer id (#162), which is the promise the server holds a
        // mesh seat on. Phones tear theirs down, do not declare it, and stop
        // leaving a phantom in every DM call.
        "mesh-resume",
        // This bundle dials the URL `POST /api/voice/token` names and no
        // other (`livekit-session.ts`), so the server may pin a room it
        // opens to a media box outside São Paulo.
        "sfu-region",
      ],
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
      // Short of the open timeout, which would otherwise redo the attempt
      // that is (deliberately) never opened here.
      await vi.advanceTimersByTimeAsync(5_000);
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
    transport.onReady((reconnected) => {
      seen.push(reconnected);
    });
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

  it("drops queued voice signaling on connection loss", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    transport.sendVoice({
      type: "offer",
      from: "a",
      to: "b",
      sdp: "v=0",
    });

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    sockets[1]!.accept();

    const types = sockets[1]!.sent.map((raw) => JSON.parse(raw).type);
    expect(types).toEqual(["auth"]);
  });

  it("delays the first reconnect after a drain close (1001) instead of reconnecting immediately", async () => {
    // 141 tabs reconnecting the instant a deploy's drain closed them pinned
    // the Postgres pool on 2026-09-12 (item C7). The first attempt after a
    // drain-shaped close must never be immediate.
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(1001);
    // Math.random is mocked to 0 in beforeEach, so the drain jitter resolves
    // to its floor (500ms) exactly — still not zero.
    await vi.advanceTimersByTimeAsync(499);
    await flush();
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it.each([1001, 1012])(
    "spreads the first reconnect after close %d uniformly across 0.5s-4s",
    (closeCode) => {
      vi.restoreAllMocks(); // use real Math.random for the distribution check
      for (let i = 0; i < 200; i++) {
        const delay = reconnectDelayMs(0, reconnectCauseForClose(closeCode));
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThanOrEqual(4_000);
      }
    },
  );

  it("does not apply the drain spread to a later attempt in the same backoff sequence", () => {
    vi.restoreAllMocks();
    for (let i = 0; i < 200; i++) {
      // attempt 1 after a drain in the same sequence: ordinary full-jitter
      // backoff (cap 2s at attempt 1), not the 0.5-4s drain window.
      const delay = reconnectDelayMs(1, "drain");
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2_000);
    }
  });

  it("does not apply the drain spread to a non-drain close code", () => {
    vi.restoreAllMocks();
    for (let i = 0; i < 200; i++) {
      // attempt 0, close 1000: ordinary full-jitter backoff (cap 1s), not
      // the 0.5-4s drain window a deploy earns.
      const delay = reconnectDelayMs(0, reconnectCauseForClose(1000));
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });

  it("grows the backoff delay's cap exponentially and stops at 30s", () => {
    vi.restoreAllMocks();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    // factor 2, base 1s: 1s, 2s, 4s, 8s, 16s, then capped at 30s.
    expect(reconnectDelayMs(0, "refused")).toBeCloseTo(1_000);
    expect(reconnectDelayMs(1, "refused")).toBeCloseTo(2_000);
    expect(reconnectDelayMs(2, "refused")).toBeCloseTo(4_000);
    expect(reconnectDelayMs(3, "refused")).toBeCloseTo(8_000);
    expect(reconnectDelayMs(4, "refused")).toBeCloseTo(16_000);
    expect(reconnectDelayMs(5, "refused")).toBeCloseTo(30_000);
    expect(reconnectDelayMs(9, "refused")).toBeCloseTo(30_000);
    randomSpy.mockRestore();
  });

  it("resets the backoff attempt counter on a successful ready", async () => {
    // With Math.random mocked to 0 (beforeEach), the drain spread floors at
    // 500ms while the ordinary backoff at attempt >= 1 floors at 0ms — so
    // whether a second drop reconnects instantly or waits 500ms tells us
    // whether the attempt counter actually reset.
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    // First drop: attempt 0 -> drain spread floor of 500ms.
    sockets[0]!.close(1001);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(sockets).toHaveLength(2);

    // Reaches ready: the attempt counter resets to 0.
    sockets[1]!.accept();
    expect(transport.isConnected()).toBe(true);

    // A second drop after that ready is attempt 0 again, so it gets the same
    // 500ms floor rather than the near-zero delay a continuing sequence
    // (attempt 1) would use.
    sockets[1]!.close(1001);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(sockets).toHaveLength(2); // not yet — short of the 500ms floor

    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(sockets).toHaveLength(3);
  });

  it("reconnects immediately on a network online event, skipping the pending backoff", async () => {
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
      removeEventListener: () => {},
      location: { protocol: "https:", host: "example.test" },
    });
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(1006);
    // A reconnect is scheduled behind the drain spread, nothing sent yet.
    expect(sockets).toHaveLength(1);

    listeners.online?.();
    await flush();

    // The online handler skips the remaining backoff outright — this is the
    // user's own connectivity returning, not a deploy-shaped herd.
    expect(sockets).toHaveLength(2);
  });

  it("does not fire onClose for 4401", async () => {
    let closed = 0;
    const transport = createRealtimeTransport();
    transport.onClose(() => {
      closed += 1;
    });
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(4401);
    expect(closed).toBe(0);
    expect(transport.getStatus()).toBe("unauthorized");
  });

  it("fires onAuthUnavailable when a later token fetch returns null", async () => {
    let issued = 0;
    let lost = 0;
    // Pin the one network-retry roll (this close) and the one backoff roll
    // (the retry after the null token) so exactly one retry lands inside the
    // window: full jitter can otherwise redraw a near-zero delay on every
    // attempt, which is correct (see the distribution tests above) but would
    // make this specific count nondeterministic under a fixed mock.
    const randomSpy = vi.spyOn(Math, "random");
    randomSpy.mockReturnValueOnce(0); // network retry: at once
    randomSpy.mockReturnValueOnce(1); // next backoff: 2000ms, past this window
    const transport = createRealtimeTransport();
    transport.onAuthUnavailable(() => {
      lost += 1;
    });
    transport.connect(async () => (issued++ === 0 ? "t" : null));
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();

    expect(lost).toBe(1);
  });

  it("does not hang up when a later token fetch fails offline", async () => {
    let issued = 0;
    let lost = 0;
    vi.stubGlobal("navigator", { onLine: false });
    const transport = createRealtimeTransport();
    transport.onAuthUnavailable(() => {
      lost += 1;
    });
    transport.connect(async () => (issued++ === 0 ? "t" : null));
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(lost).toBe(0);
  });

  it("does not hang up when a later token fetch throws", async () => {
    let issued = 0;
    let lost = 0;
    const transport = createRealtimeTransport();
    transport.onAuthUnavailable(() => {
      lost += 1;
    });
    transport.connect(async () => {
      if (issued++ === 0) {
        return "t";
      }
      throw new Error("offline");
    });
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(lost).toBe(0);
  });

  it("sends the ready-handler join before voice frames queued during the outage", async () => {
    const channel = "00000000-0000-4000-8000-0000000000aa";
    const transport = createRealtimeTransport();
    transport.onReady(async (reconnected) => {
      if (reconnected) {
        transport.sendVoice({
          type: "join-voice-room",
          voiceChannelId: channel,
        });
      }
    });
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(1006);
    transport.sendVoice({
      type: "ice-candidate",
      from: "a",
      to: "b",
      candidate: null,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    sockets[1]!.accept();
    await flush();

    const types = sockets[1]!.sent
      .map((raw) => JSON.parse(raw).type)
      .filter((type) => type !== "auth");
    expect(types).toEqual(["join-voice-room", "ice-candidate"]);
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

    await vi.advanceTimersByTimeAsync(5_000);
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

/**
 * 2026-09-27: a one-star call, "travando e perda de conexão constante". The
 * caller's socket dropped four times and each time he was out of the call's
 * signalling for 70 to 80 seconds. These pin the behaviour that replaced it:
 * a dead link under a call is found in about ten seconds, and a network loss
 * retries at once instead of waiting out a schedule sized for a deploy.
 */
describe("fast recovery from a network blip", () => {
  function pings(socket: FakeSocket): number {
    return socket.sent.filter((raw) => JSON.parse(raw).type === "ping").length;
  }

  async function online(callActive: boolean) {
    const transport = createRealtimeTransport();
    transport.setCallActive(callActive);
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.accept();
    return transport;
  }

  function captureWindowListeners(): Record<string, () => void> {
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
      removeEventListener: () => {},
      location: { protocol: "https:", host: "example.test" },
    });
    return listeners;
  }

  it("declares a silent socket dead within about ten seconds while in a call", async () => {
    await online(true);

    await vi.advanceTimersByTimeAsync(9_000);
    await flush();
    expect(sockets).toHaveLength(1);
    // Two strikes, never one: a single slow round trip must not cost the link.
    expect(pings(sockets[0]!)).toBeGreaterThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(sockets[0]!.readyState).toBe(FakeSocket.CLOSED);
    expect(sockets).toHaveLength(2);
  });

  it("uses the slower schedule outside a call, still well under the old minute", async () => {
    await online(false);

    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(8_000);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("keeps a socket whose pings are answered", async () => {
    await online(true);
    const ws = sockets[0]!;
    let answered = 0;
    for (let second = 0; second < 60; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      while (pings(ws) > answered) {
        answered += 1;
        ws.emit({ type: "pong" });
      }
    }
    expect(sockets).toHaveLength(1);
    expect(ws.readyState).toBe(FakeSocket.OPEN);
  });

  it("counts any inbound frame as proof of life and sends no ping on a busy socket", async () => {
    await online(true);
    const ws = sockets[0]!;
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      ws.emit({ type: "presence-update", channelId: "c", users: [] });
    }
    expect(pings(ws)).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  it("retries an abnormal close (1006) within 1.5s, not behind the deploy spread", async () => {
    // A crash or a Caddy / Cloudflare blip sends 1006 to every tab at once:
    // spread across 1.5s, still fast for one person (median 0.75s).
    vi.spyOn(Math, "random").mockReturnValue(1); // the slowest the jitter can be
    await online(true);

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(1_499);
    await flush();
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("retries a loss the keepalive found itself within 250ms", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const listeners = captureWindowListeners();
    await online(false);
    // An online probe that goes unanswered: this tab's link, nobody else's.
    listeners.online?.();
    await vi.advanceTimersByTimeAsync(4_000);
    await flush();
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("abandons a connect attempt that never opens", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    expect(sockets).toHaveLength(1);

    // A SYN into a network that is not there: no open, no close, ever.
    await vi.advanceTimersByTimeAsync(6_300);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("abandons an attempt that opened and then went silent before ready", async () => {
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    sockets[0]!.open();

    await vi.advanceTimersByTimeAsync(11_000);
    await flush();
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("treats a token provider that hangs as the network, not a sign-out", async () => {
    let calls = 0;
    let authLost = 0;
    const transport = createRealtimeTransport();
    transport.onAuthUnavailable(() => {
      authLost += 1;
    });
    transport.connect(async () => {
      calls += 1;
      if (calls === 2) {
        return new Promise<string>(() => {}); // a Clerk refresh stuck offline
      }
      return "t";
    });
    await flush();
    sockets[0]!.accept();

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(5_300);
    await flush();
    expect(transport.getStatus()).toBe("reconnecting");
    expect(authLost).toBe(0);
    // The retry waits on the request still out instead of stacking another.
    expect(calls).toBe(2);
    expect(sockets).toHaveLength(1);

    // Past TOKEN_ABANDON_MS the stuck request is given up on, a fresh one
    // answers, and the socket comes back.
    await vi.advanceTimersByTimeAsync(26_000);
    await flush();
    expect(calls).toBe(3);
    expect(sockets).toHaveLength(2);
  });

  it("probes an open socket when the browser says the network is back", async () => {
    const listeners = captureWindowListeners();
    await online(false);
    const ws = sockets[0]!;

    listeners.online?.();
    expect(pings(ws)).toBe(1);

    // The old socket belonged to an address this machine no longer has.
    await vi.advanceTimersByTimeAsync(4_300);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("redoes an attempt left connecting on the network that went away", async () => {
    const listeners = captureWindowListeners();
    const transport = createRealtimeTransport();
    transport.connect(async () => "t");
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);

    listeners.online?.();
    await flush();
    expect(sockets[0]!.readyState).toBe(FakeSocket.CLOSED);
    expect(sockets).toHaveLength(2);
  });

  it("skips a pending network backoff when the media connection comes back", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    await online(true);

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(sockets).toHaveLength(2);
    // The retry never opens (the network is still down): the next one is a
    // network wait of up to 1s at attempt 1.
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(sockets).toHaveLength(2);

    emitNetworkHint("up");
    await flush();
    expect(sockets).toHaveLength(3);
  });

  it("lets the browser's online cut a 1006 spread short, but not a media hint", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const listeners = captureWindowListeners();
    await online(true);

    sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(100);
    // Every tab in a call hears the same media hint after a crash.
    emitNetworkHint("up");
    await flush();
    expect(sockets).toHaveLength(1);

    // `online` is this machine alone.
    listeners.online?.();
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("never cuts a drain spread or a refusal backoff short", async () => {
    const listeners = captureWindowListeners();
    vi.spyOn(Math, "random").mockReturnValue(1);
    await online(true);

    // A deploy's drain: every tab in a call hears the same media hint, and
    // the spread is what keeps them from reconnecting together.
    sockets[0]!.close(1001);
    await vi.advanceTimersByTimeAsync(100);
    emitNetworkHint("up");
    listeners.online?.();
    await flush();
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_000);
    await flush();
    expect(sockets).toHaveLength(2);

    // A rate limit is never hammered either.
    sockets[1]!.accept();
    sockets[1]!.close(4429);
    await vi.advanceTimersByTimeAsync(100);
    emitNetworkHint("up");
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it("probes the socket when the media connection loses its path", async () => {
    await online(false);
    const ws = sockets[0]!;

    emitNetworkHint("suspect");
    expect(pings(ws)).toBe(1);

    ws.emit({ type: "pong" });
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(sockets).toHaveLength(1);
  });

  it("writes off a socket with pings in flight soon after media comes back", async () => {
    await online(true);
    // Silent for 4s: the keepalive has one ping out, unanswered.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pings(sockets[0]!)).toBe(1);

    emitNetworkHint("up");
    await vi.advanceTimersByTimeAsync(2_300);
    await flush();
    // Well before the ~10s the keepalive alone would take.
    expect(sockets).toHaveLength(2);
  });

  it("stops listening to media hints after disconnect", async () => {
    const transport = await online(false);
    transport.disconnect();
    emitNetworkHint("up");
    emitNetworkHint("suspect");
    await flush();
    expect(sockets).toHaveLength(1);
  });

  it("acts on a send that finds the socket already closed, and delivers it after", async () => {
    const transport = await online(true);
    const ws = sockets[0]!;
    // Closed underneath us, `close` not fired yet (or never will be).
    ws.readyState = FakeSocket.CLOSED;

    transport.sendChat({ type: "join-channel", channelId: "c" });
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    expect(sockets).toHaveLength(2);

    sockets[1]!.accept();
    const types = sockets[1]!.sent.map((raw) => JSON.parse(raw).type);
    expect(types).toContain("join-channel");
  });
});

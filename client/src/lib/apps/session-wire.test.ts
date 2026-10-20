import type { AppClientFrame } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppSessionWire,
  ENDED_WHILE_AWAY,
  JOIN_TIMEOUT_MS,
  type AppSessionWire,
  type AppWireLink,
} from "./session-wire";
import { AppTransportError, type AppSessionHandlers } from "./types";

const SESSION = "6d6c1f3e-0a6c-4a53-9c3d-2f3b6c2a9e11";
const OTHER = "0b4f4e0e-6c53-45f6-a8f4-7b3a4a7bd001";
const SEAT = "AAAAAAAAAAAAAAAAAAAAAA";

function setup() {
  const sent: AppClientFrame[] = [];
  let up = true;
  const link: { current: AppWireLink | null } = {
    current: {
      send: (frame) => {
        if (!up) return false;
        sent.push(frame);
        return true;
      },
    },
  };
  const wire = createAppSessionWire(link);
  return {
    wire,
    sent,
    setLinkUp: (value: boolean) => {
      up = value;
    },
  };
}

function snapshotFrame(over: Record<string, unknown> = {}) {
  return {
    type: "app-session",
    sessionId: SESSION,
    seatId: SEAT,
    role: "player",
    isHost: false,
    state: { rev: 3, value: { n: 1 } },
    participants: [
      { seatId: SEAT, userId: OTHER, role: "player", isHost: false, connection: "present" },
    ],
    ...over,
  };
}

function handlers(): AppSessionHandlers & {
  calls: Array<[string, unknown]>;
} {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    onSession: (snapshot) => calls.push(["session", snapshot.seatId]),
    onState: (rev, value) => calls.push(["state", { rev, value }]),
    onEvent: (event) => calls.push(["event", event]),
    onConnection: (status) => calls.push(["connection", status]),
    onEnded: (reason) => calls.push(["ended", reason]),
  };
}

function open(wire: AppSessionWire, h = handlers()) {
  const transport = wire.transportFor(SESSION, async () => {});
  const off = transport.subscribe(h);
  return { transport, off, h };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the app session wire", () => {
  it("hands out one transport per session", () => {
    const { wire } = setup();
    expect(wire.transportFor(SESSION, async () => {})).toBe(wire.transportFor(SESSION, async () => {}));
    expect(wire.transportFor(OTHER, async () => {})).not.toBe(wire.transportFor(SESSION, async () => {}));
  });

  it("joins: sends app-join and resolves on the app-session snapshot", async () => {
    const { wire, sent } = setup();
    const { transport } = open(wire);
    const joined = transport.join({});
    expect(sent).toEqual([{ type: "app-join", sessionId: SESSION }]);
    expect(wire.dispatch(snapshotFrame())).toBe(true);
    await expect(joined).resolves.toMatchObject({ seatId: SEAT, role: "player", state: { rev: 3 } });
    expect(wire.isSeated(SESSION)).toBe(true);
  });

  it("asks to join as a spectator when told to", async () => {
    const { wire, sent } = setup();
    const { transport } = open(wire);
    void transport.join({ asSpectator: true });
    expect(sent[0]).toEqual({ type: "app-join", sessionId: SESSION, asSpectator: true });
  });

  it("a second join while one is in flight shares its answer (a remount) and sends one frame", async () => {
    const { wire, sent } = setup();
    const { transport } = open(wire);
    const first = transport.join({});
    const second = transport.join({});
    expect(second).toBe(first);
    expect(sent).toHaveLength(1);
    wire.dispatch(snapshotFrame());
    await expect(first).resolves.toBeDefined();
  });

  it("rejects a refused join with the server's code", async () => {
    const { wire } = setup();
    const { transport } = open(wire);
    const joined = transport.join({});
    wire.dispatch({ type: "app-error", sessionId: SESSION, op: "join", code: "full" });
    await expect(joined).rejects.toMatchObject({ code: "full" });
    expect(wire.isSeated(SESSION)).toBe(false);
  });

  it("rejects a join nobody answers after the timeout", async () => {
    const { wire } = setup();
    const { transport } = open(wire);
    const joined = transport.join({});
    const outcome = joined.catch((error) => error);
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS + 1);
    expect(await outcome).toBeInstanceOf(AppTransportError);
  });

  it("a transport kept after a failed join (the pane's Try again) still hears the next answer", async () => {
    const { wire, sent } = setup();
    // the layout memoises the transport for as long as the session id is the same
    const transport = wire.transportFor(SESSION, async () => {});
    const off = transport.subscribe(handlers());
    const first = transport.join({}).catch((error) => error);
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS + 1);
    expect(await first).toBeInstanceOf(AppTransportError);
    // the failed frame lets go, which drops the record from the wire
    off();
    // the retry uses the same transport object
    const h = handlers();
    transport.subscribe(h);
    const again = transport.join({});
    expect(sent.filter((frame) => frame.type === "app-join")).toHaveLength(2);
    expect(wire.dispatch(snapshotFrame())).toBe(true);
    await expect(again).resolves.toMatchObject({ seatId: SEAT });
    expect(wire.isSeated(SESSION)).toBe(true);
    expect(h.calls).toContainEqual(["session", SEAT]);
  });

  it("a frame removed while its join was in flight does not release the seat its remount holds", async () => {
    const { wire, sent } = setup();
    const transport = wire.transportFor(SESSION, async () => {});
    // the first frame subscribes and asks
    const offFirst = transport.subscribe(handlers());
    const first = transport.join({});
    // it is removed and mounted again before the answer: the second shares the join
    offFirst();
    const second = handlers();
    transport.subscribe(second);
    const again = transport.join({});
    wire.dispatch(snapshotFrame());
    await expect(first).resolves.toMatchObject({ seatId: SEAT });
    await expect(again).resolves.toMatchObject({ seatId: SEAT });
    // the removed frame finds itself detached and lets the seat go: nothing is sent
    transport.leave();
    expect(sent.filter((frame) => frame.type === "app-leave")).toHaveLength(0);
    expect(wire.isSeated(SESSION)).toBe(true);
  });

  it("rejects at once when the socket cannot take the frame", async () => {
    const { wire, setLinkUp } = setup();
    setLinkUp(false);
    const { transport } = open(wire);
    await expect(transport.join({})).rejects.toMatchObject({ code: "unavailable" });
  });

  it("answers a state patch with the next app-state revision", async () => {
    const { wire, sent } = setup();
    const { transport } = open(wire);
    const joined = transport.join({});
    wire.dispatch(snapshotFrame());
    await joined;
    const written = transport.patchState({ n: 2 }, 3);
    expect(sent.at(-1)).toEqual({ type: "app-state-patch", sessionId: SESSION, baseRev: 3, patch: { n: 2 } });
    wire.dispatch({ type: "app-state", sessionId: SESSION, rev: 4, value: { n: 2 } });
    await expect(written).resolves.toEqual({ rev: 4 });
  });

  it("rejects a state patch the server refused, oldest first", async () => {
    const { wire } = setup();
    const { transport } = open(wire);
    const joined = transport.join({});
    wire.dispatch(snapshotFrame());
    await joined;
    const written = transport.patchState({ n: 2 }, 0);
    wire.dispatch({ type: "app-error", sessionId: SESSION, op: "state", code: "stale-rev" });
    await expect(written).rejects.toMatchObject({ code: "stale-rev" });
  });

  it("does not send state or events for a seat it does not hold", async () => {
    const { wire, sent } = setup();
    const { transport } = open(wire);
    transport.sendEvent("ping", { a: 1 });
    await expect(transport.patchState({}, undefined)).rejects.toMatchObject({ code: "unavailable" });
    expect(sent).toEqual([]);
  });

  it("relays state, events and the end to the handlers", async () => {
    const { wire } = setup();
    const { transport, h } = open(wire);
    const joined = transport.join({});
    wire.dispatch(snapshotFrame());
    await joined;
    wire.dispatch({ type: "app-state", sessionId: SESSION, rev: 5, value: { n: 5 } });
    wire.dispatch({ type: "app-event", sessionId: SESSION, fromSeatId: SEAT, name: "ping", data: 1 });
    wire.dispatch({
      type: "app-ended",
      sessionId: SESSION,
      channelId: OTHER,
      reason: "host",
      summary: { participants: 2, durationSeconds: 90 },
    });
    expect(h.calls.map(([kind]) => kind)).toEqual(["session", "state", "event", "ended"]);
    expect(h.calls.at(-1)).toEqual(["ended", "host"]);
    expect(wire.isSeated(SESSION)).toBe(false);
  });

  it("leave releases the seat once and only if it was held", async () => {
    const { wire, sent } = setup();
    const { transport } = open(wire);
    transport.leave();
    expect(sent).toEqual([]);
    const joined = transport.join({});
    wire.dispatch(snapshotFrame());
    await joined;
    transport.leave();
    transport.leave();
    expect(sent.filter((frame) => frame.type === "app-leave")).toHaveLength(1);
  });

  it("tells the handlers the link dropped, and takes the seat back when it returns", async () => {
    const { wire, sent } = setup();
    const { transport, h } = open(wire);
    const joined = transport.join({ asSpectator: true });
    wire.dispatch(snapshotFrame({ role: "spectator" }));
    await joined;
    sent.length = 0;

    wire.setOnline(false);
    expect(h.calls.at(-1)).toEqual(["connection", "reconnecting"]);

    wire.setOnline(true);
    wire.resume();
    // the same seat is asked for again, as the spectator it was
    expect(sent).toEqual([{ type: "app-join", sessionId: SESSION, asSpectator: true }]);
    // not back until the server says so
    expect(h.calls.at(-1)).toEqual(["connection", "reconnecting"]);
    wire.dispatch(snapshotFrame({ role: "spectator" }));
    expect(h.calls.at(-1)).toEqual(["connection", "online"]);
  });

  it("a resume that finds the session over ends it for the host", async () => {
    const { wire, sent } = setup();
    const { transport, h } = open(wire);
    const joined = transport.join({});
    wire.dispatch(snapshotFrame());
    await joined;
    wire.setOnline(false);
    wire.setOnline(true);
    wire.resume();
    expect(sent.at(-1)).toMatchObject({ type: "app-join" });
    wire.dispatch({ type: "app-error", sessionId: SESSION, op: "join", code: "ended" });
    expect(h.calls.at(-1)).toEqual(["ended", ENDED_WHILE_AWAY]);
  });

  it("does not resume a seat it released", async () => {
    const { wire, sent } = setup();
    const { transport } = open(wire);
    const joined = transport.join({});
    wire.dispatch(snapshotFrame());
    await joined;
    transport.leave();
    sent.length = 0;
    wire.setOnline(false);
    wire.setOnline(true);
    wire.resume();
    expect(sent).toEqual([]);
  });

  it("ignores frames for sessions it holds nothing for, and frames it cannot read", () => {
    const { wire } = setup();
    expect(wire.dispatch(snapshotFrame())).toBe(false);
    expect(wire.dispatch({ type: "voice-roster" })).toBe(false);
    expect(wire.dispatch({ type: "app-state", sessionId: "not-a-uuid" })).toBe(false);
  });

  it("sendJoin and sendLeave serve the card without a record", () => {
    const { wire, sent } = setup();
    expect(wire.sendJoin(SESSION, { asSpectator: true })).toBe(true);
    expect(wire.sendLeave(SESSION)).toBe(true);
    expect(sent).toEqual([
      { type: "app-join", sessionId: SESSION, asSpectator: true },
      { type: "app-leave", sessionId: SESSION },
    ]);
  });
});

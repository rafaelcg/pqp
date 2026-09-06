import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  createCoalescer,
  droppedFrameCount,
  encodeFrame,
  SEND_BACKPRESSURE_BYTES,
  sendEncoded,
  sendEncodedDroppable,
} from "./fanout.js";

interface Fake {
  socket: WebSocket;
  sent: Array<{ data: unknown; options: unknown }>;
  bufferedAmount: number;
  readyState: number;
}

function fakeSocket(bufferedAmount = 0, readyState = 1): Fake {
  const fake: Fake = {
    sent: [],
    bufferedAmount,
    readyState,
    socket: null as unknown as WebSocket,
  };
  fake.socket = {
    get readyState() {
      return fake.readyState;
    },
    get bufferedAmount() {
      return fake.bufferedAmount;
    },
    send(data: unknown, options: unknown) {
      fake.sent.push({ data, options });
    },
  } as unknown as WebSocket;
  return fake;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("encodeFrame / sendEncoded", () => {
  it("encodes once to a Buffer and sends it as a text frame", () => {
    const frame = encodeFrame({ type: "typing-broadcast", channelId: "c" });
    expect(Buffer.isBuffer(frame)).toBe(true);
    expect(JSON.parse(frame.toString("utf8"))).toEqual({
      type: "typing-broadcast",
      channelId: "c",
    });

    const a = fakeSocket();
    const b = fakeSocket();
    sendEncoded(a.socket, frame);
    sendEncoded(b.socket, frame);
    // The very same Buffer reaches both sockets, and the wire opcode stays
    // text so an unchanged client parses it exactly as before.
    expect(a.sent[0]!.data).toBe(frame);
    expect(b.sent[0]!.data).toBe(frame);
    expect(a.sent[0]!.options).toEqual({ binary: false });
  });

  it("does not send to a socket that is not open", () => {
    const closed = fakeSocket(0, 3);
    sendEncoded(closed.socket, encodeFrame({ type: "x" }));
    expect(sendEncodedDroppable(closed.socket, encodeFrame({ type: "x" }))).toBe(
      false,
    );
    expect(closed.sent).toHaveLength(0);
  });
});

describe("sendEncodedDroppable", () => {
  it("sends while the socket is under the backpressure threshold", () => {
    const fake = fakeSocket(SEND_BACKPRESSURE_BYTES);
    expect(sendEncodedDroppable(fake.socket, encodeFrame({ type: "x" }))).toBe(
      true,
    );
    expect(fake.sent).toHaveLength(1);
  });

  it("drops the frame for a socket that is over the threshold", () => {
    const before = droppedFrameCount();
    const fake = fakeSocket(SEND_BACKPRESSURE_BYTES + 1);
    expect(sendEncodedDroppable(fake.socket, encodeFrame({ type: "x" }))).toBe(
      false,
    );
    expect(fake.sent).toHaveLength(0);
    expect(droppedFrameCount()).toBe(before + 1);

    // The moment the queue drains, the socket is served again: dropping is a
    // per-frame decision, never a mark on the socket.
    fake.bufferedAmount = 0;
    expect(sendEncodedDroppable(fake.socket, encodeFrame({ type: "x" }))).toBe(
      true,
    );
  });

  it("never drops through the non-droppable path", () => {
    const fake = fakeSocket(SEND_BACKPRESSURE_BYTES * 10);
    sendEncoded(fake.socket, encodeFrame({ type: "message-broadcast" }));
    expect(fake.sent).toHaveLength(1);
  });
});

describe("createCoalescer", () => {
  it("folds a burst of requests for one key into a single run", async () => {
    const runs: string[] = [];
    const coalescer = createCoalescer<string>(20, (key) => {
      runs.push(key);
    });
    const promises = [
      coalescer.request("a"),
      coalescer.request("a"),
      coalescer.request("a"),
    ];
    expect(coalescer.pending()).toBe(1);
    expect(runs).toEqual([]);
    await Promise.all(promises);
    expect(runs).toEqual(["a"]);
    expect(coalescer.pending()).toBe(0);
  });

  it("keeps keys independent", async () => {
    const runs: string[] = [];
    const coalescer = createCoalescer<string>(10, (key) => {
      runs.push(key);
    });
    await Promise.all([coalescer.request("a"), coalescer.request("b")]);
    expect(runs.sort()).toEqual(["a", "b"]);
  });

  it("reads state at fire time, so the newest snapshot is what goes out", async () => {
    let state = 0;
    const seen: number[] = [];
    const coalescer = createCoalescer<string>(20, () => {
      seen.push(state);
    });
    const p = coalescer.request("room");
    state = 1;
    void coalescer.request("room");
    state = 2;
    await p;
    expect(seen).toEqual([2]);
  });

  it("a request after the window opens a new window", async () => {
    const runs: number[] = [];
    let n = 0;
    const coalescer = createCoalescer<string>(10, () => {
      runs.push(++n);
    });
    await coalescer.request("a");
    await coalescer.request("a");
    expect(runs).toEqual([1, 2]);
  });

  it("serialises runs per key so an older snapshot never lands after a newer one", async () => {
    const order: string[] = [];
    let first = true;
    const coalescer = createCoalescer<string>(0, async () => {
      if (first) {
        first = false;
        order.push("slow-start");
        await wait(40);
        order.push("slow-end");
        return;
      }
      order.push("fast");
    });
    const p1 = coalescer.request("a");
    await wait(5);
    const p2 = coalescer.request("a");
    await Promise.all([p1, p2]);
    expect(order).toEqual(["slow-start", "slow-end", "fast"]);
  });

  it("resolves every waiter even when the run throws, and logs instead of rejecting", async () => {
    const coalescer = createCoalescer<string>(0, () => {
      throw new Error("boom");
    });
    await expect(coalescer.request("a")).resolves.toBeUndefined();
  });

  it("reset drops pending windows without running them", async () => {
    const runs: string[] = [];
    const coalescer = createCoalescer<string>(10, (key) => {
      runs.push(key);
    });
    const p = coalescer.request("a");
    coalescer.reset();
    await p;
    await wait(20);
    expect(runs).toEqual([]);
    expect(coalescer.pending()).toBe(0);
  });
});

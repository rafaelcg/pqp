import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannelWriteQueue,
  createLiveReadAck,
  type ChannelWriteQueue,
} from "./live-read-ack";

/** A request that stays in flight until the test says it answered. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets queued promise callbacks run; fake timers do not touch microtasks. */
const drain = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

describe("createChannelWriteQueue", () => {
  it("sends a channel's writes one at a time, in order", async () => {
    const queue = createChannelWriteQueue();
    const log: string[] = [];
    const first = deferred();
    void queue.run("c1", () => {
      log.push("ack");
      return first.promise;
    });
    void queue.run("c1", async () => {
      log.push("rewind");
    });
    await drain();
    expect(log).toEqual(["ack"]);
    first.resolve();
    await drain();
    expect(log).toEqual(["ack", "rewind"]);
  });

  it("does not stall after a failed write", async () => {
    const queue = createChannelWriteQueue();
    const failed = queue.run("c1", () => Promise.reject(new Error("offline")));
    const next = queue.run("c1", async () => "ok");
    await expect(failed).rejects.toThrow("offline");
    await expect(next).resolves.toBe("ok");
  });

  it("does not make one channel wait for another", async () => {
    const queue = createChannelWriteQueue();
    const slow = deferred();
    void queue.run("c1", () => slow.promise);
    await expect(queue.run("c2", async () => "c2")).resolves.toBe("c2");
  });
});

describe("createLiveReadAck", () => {
  let visible: boolean;
  let selected: string | null;
  let held: Set<string>;
  let queue: ChannelWriteQueue;
  let send: ReturnType<typeof vi.fn<(channelId: string) => Promise<unknown>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    visible = true;
    selected = "c1";
    held = new Set();
    queue = createChannelWriteQueue();
    send = vi.fn(() => Promise.resolve());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () =>
    createLiveReadAck({
      queue,
      send,
      isVisible: () => visible,
      isSelected: (channelId) => selected === channelId,
      isHeld: (channelId) => held.has(channelId),
      delayMs: 1000,
    });

  it("acks once after a quiet second, however many messages arrived", async () => {
    const ack = make();
    ack.note("c1");
    vi.advanceTimersByTime(500);
    ack.note("c1");
    ack.note("c1");
    vi.advanceTimersByTime(999);
    await drain();
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("c1");
  });

  it("does not ack while the page is hidden, and does once it shows", async () => {
    const ack = make();
    visible = false;
    ack.note("c1");
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).not.toHaveBeenCalled();
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not ack when the tab hides before the pending timer fires", async () => {
    const ack = make();
    ack.note("c1");
    vi.advanceTimersByTime(500);
    visible = false;
    // Arrives while hidden: finds the running timer and leaves it alone.
    ack.note("c1");
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).not.toHaveBeenCalled();
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops what waited in a hidden tab once the channel is left", async () => {
    const ack = make();
    visible = false;
    ack.note("c1");
    selected = "c2";
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).not.toHaveBeenCalled();

    visible = false;
    selected = "c1";
    ack.note("c1");
    ack.flush("c1");
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not overwrite a Mark unread made after the arrival", async () => {
    const ack = make();
    ack.note("c1");
    held.add("c1");
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).not.toHaveBeenCalled();
  });

  it("lands an ack already in flight before a Mark unread made after it", async () => {
    const log: string[] = [];
    const ackRequest = deferred();
    send.mockImplementationOnce(() => {
      log.push("ack");
      return ackRequest.promise;
    });
    const ack = make();
    ack.note("c1");
    vi.advanceTimersByTime(1000);
    await drain();
    expect(log).toEqual(["ack"]);

    // Mark unread while the ack is on the wire.
    held.add("c1");
    const rewind = queue.run("c1", async () => {
      log.push("rewind");
    });
    await drain();
    expect(log).toEqual(["ack"]);
    ackRequest.resolve();
    await rewind;
    expect(log).toEqual(["ack", "rewind"]);
  });

  it("skips an ack queued behind another write if Mark unread came in between", async () => {
    const open = deferred();
    void queue.run("c1", () => open.promise);
    const ack = make();
    ack.note("c1");
    vi.advanceTimersByTime(1000);
    await drain();
    held.add("c1");
    open.resolve();
    await drain();
    expect(send).not.toHaveBeenCalled();
  });

  it("makes overlapping acks and the next open wait for every earlier ack", async () => {
    const log: string[] = [];
    const first = deferred();
    const second = deferred();
    send
      .mockImplementationOnce(() => {
        log.push("ack 1");
        return first.promise;
      })
      .mockImplementationOnce(() => {
        log.push("ack 2");
        return second.promise;
      });
    const ack = make();
    ack.note("c1");
    vi.advanceTimersByTime(1000);
    ack.note("c1");
    vi.advanceTimersByTime(1000);
    await drain();
    expect(log).toEqual(["ack 1"]);

    const reopen = queue.run("c1", async () => {
      log.push("open");
    });
    // The newer ack answering first must not let the open through.
    second.resolve();
    await drain();
    expect(log).toEqual(["ack 1"]);
    first.resolve();
    await reopen;
    expect(log).toEqual(["ack 1", "ack 2", "open"]);
  });

  it("acks at once on leave, and only when something is waiting", async () => {
    const ack = make();
    ack.flush("c1");
    ack.note("c1");
    ack.flush("c1");
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps acking after a failed request", async () => {
    send.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const ack = make();
    ack.note("c1");
    vi.advanceTimersByTime(1000);
    await drain();
    ack.note("c1");
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

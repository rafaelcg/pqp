import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannelWriteQueue,
  createLiveReadAck,
  LIVE_READ_ACK_MAX_RETRIES,
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
  let atLiveEnd: boolean;
  let selected: string | null;
  let held: Set<string>;
  let queue: ChannelWriteQueue;
  let send: ReturnType<
    typeof vi.fn<(channelId: string, lastReadAt: string) => Promise<unknown>>
  >;
  /** Server timestamps, one second apart, in arrival order. */
  let clock: number;
  const at = () => new Date((clock += 1000)).toISOString();
  /** The cursor an ack of the message stamped `createdAt` sends. */
  const after = (createdAt: string) =>
    new Date(Date.parse(createdAt) + 1).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    visible = true;
    atLiveEnd = true;
    selected = "c1";
    held = new Set();
    queue = createChannelWriteQueue();
    send = vi.fn(() => Promise.resolve());
    clock = Date.parse("2026-09-29T12:00:00.000Z");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () =>
    createLiveReadAck({
      queue,
      send,
      isVisible: () => visible,
      isAtLiveEnd: () => atLiveEnd,
      isSelected: (channelId) => selected === channelId,
      isHeld: (channelId) => held.has(channelId),
      delayMs: 1000,
    });

  it("acks once after a quiet second, however many messages arrived", async () => {
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(500);
    ack.note("c1", at());
    const newest = at();
    ack.note("c1", newest);
    vi.advanceTimersByTime(999);
    await drain();
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    // Just past the newest message seen, never the server's NOW().
    expect(send).toHaveBeenCalledWith("c1", after(newest));
  });

  it("keeps the newest message as the cursor when broadcasts arrive out of order", async () => {
    const ack = make();
    const older = at();
    const newer = at();
    ack.note("c1", newer);
    ack.note("c1", older);
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledWith("c1", after(newer));
  });

  it("does not ack while the page is hidden, and does once it shows", async () => {
    const ack = make();
    visible = false;
    ack.note("c1", at());
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
    ack.note("c1", at());
    vi.advanceTimersByTime(500);
    visible = false;
    // Arrives while hidden: finds the running timer and leaves it alone.
    ack.note("c1", at());
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
    ack.note("c1", at());
    selected = "c2";
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).not.toHaveBeenCalled();

    visible = false;
    selected = "c1";
    ack.note("c1", at());
    ack.flush("c1");
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not overwrite a Mark unread made after the arrival", async () => {
    const ack = make();
    ack.note("c1", at());
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
    ack.note("c1", at());
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
    ack.note("c1", at());
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
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    ack.note("c1", at());
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

  it("keeps one ack waiting behind a slow request, however many fire", async () => {
    const slow = deferred();
    send.mockImplementationOnce(() => slow.promise);
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    for (let i = 0; i < 5; i += 1) {
      ack.note("c1", at());
      vi.advanceTimersByTime(1000);
    }
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    slow.resolve();
    await drain();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops a queued ack once the reader has left the channel", async () => {
    const slow = deferred();
    void queue.run("c1", () => slow.promise);
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    // Left while the ack waited: NOW() would cover what arrives after.
    selected = "c2";
    slow.resolve();
    await drain();
    expect(send).not.toHaveBeenCalled();
  });

  it("parks a queued ack if the tab hid while it waited", async () => {
    const slow = deferred();
    void queue.run("c1", () => slow.promise);
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    visible = false;
    slow.resolve();
    await drain();
    expect(send).not.toHaveBeenCalled();
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("queues the leave ack behind a slow write, with the cursor fixed at leave", async () => {
    const slow = deferred();
    void queue.run("c1", () => slow.promise);
    const ack = make();
    const seen = at();
    ack.note("c1", seen);
    ack.flush("c1");
    selected = "c2";
    slow.resolve();
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("c1", after(seen));
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("acks at once on leave, and only when something is waiting", async () => {
    const ack = make();
    ack.flush("c1");
    const seen = at();
    ack.note("c1", seen);
    ack.flush("c1");
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("c1", after(seen));
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not let a leave ack that starts late cover what arrived after leaving", async () => {
    // The queue starts a task from a promise callback, so the reader is gone
    // (and the next message has arrived) before the leave ack sends.
    const ack = make();
    const seen = at();
    ack.note("c1", seen);
    ack.flush("c1");
    selected = "c2";
    at();
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("c1", after(seen));
  });

  it("does not send a leave ack for Mark unread", async () => {
    const ack = make();
    ack.note("c1", at());
    held.add("c1");
    ack.flush("c1");
    await drain();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not ack a message that lands below a reader scrolled up", async () => {
    const ack = make();
    atLiveEnd = false;
    ack.note("c1", at());
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).not.toHaveBeenCalled();
    // Leaving without scrolling down: nothing was seen, nothing is sent.
    ack.flush("c1");
    await drain();
    expect(send).not.toHaveBeenCalled();
  });

  it("acks what waited once the reader scrolls back to the live end", async () => {
    const ack = make();
    atLiveEnd = false;
    const waited = at();
    ack.note("c1", waited);
    vi.advanceTimersByTime(5000);
    atLiveEnd = true;
    ack.resume();
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("c1", after(waited));
  });

  it("does not ack when the reader scrolls up during the quiet second", async () => {
    const ack = make();
    const seen = at();
    ack.note("c1", seen);
    vi.advanceTimersByTime(500);
    atLiveEnd = false;
    ack.note("c1", at());
    vi.advanceTimersByTime(5000);
    await drain();
    expect(send).not.toHaveBeenCalled();
    // The first one was seen, the second was not.
    ack.flush("c1");
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("c1", after(seen));
  });

  it("parks a queued ack if the reader scrolled up while it waited", async () => {
    const slow = deferred();
    void queue.run("c1", () => slow.promise);
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    atLiveEnd = false;
    slow.resolve();
    await drain();
    expect(send).not.toHaveBeenCalled();
    atLiveEnd = true;
    ack.resume();
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a failed ack with no later message to trigger one", async () => {
    send.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const ack = make();
    const seen = at();
    ack.note("c1", seen);
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1999);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await drain();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("c1", after(seen));
    vi.advanceTimersByTime(60_000);
    await drain();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries through the same checks, so a hidden tab waits", async () => {
    send.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    visible = false;
    vi.advanceTimersByTime(60_000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gives up after a bounded number of retries", async () => {
    send.mockImplementation(() => Promise.reject(new Error("offline")));
    const ack = make();
    ack.note("c1", at());
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(60_000);
      await drain();
    }
    expect(send).toHaveBeenCalledTimes(1 + LIVE_READ_ACK_MAX_RETRIES);
  });

  it("does not retry after the reader left, even once they are back", async () => {
    const failing = deferred();
    send.mockImplementationOnce(() => failing.promise);
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    // Leave and come back while the ack is on the wire: the next open's read
    // is queued behind it, and a retry would land after that read.
    ack.flush("c1");
    selected = "c2";
    selected = "c1";
    failing.reject(new Error("offline"));
    await drain();
    vi.advanceTimersByTime(60_000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not retry the leave ack", async () => {
    send.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const ack = make();
    ack.note("c1", at());
    ack.flush("c1");
    selected = "c2";
    await drain();
    vi.advanceTimersByTime(60_000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("clears retry timers on dispose", async () => {
    send.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    ack.dispose();
    vi.advanceTimersByTime(60_000);
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps acking after a failed request", async () => {
    send.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const ack = make();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    ack.note("c1", at());
    vi.advanceTimersByTime(1000);
    await drain();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

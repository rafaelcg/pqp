import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveReadAck } from "./live-read-ack";

describe("createLiveReadAck", () => {
  let visible: boolean;
  let held: Set<string>;
  let send: ReturnType<typeof vi.fn<(channelId: string) => Promise<unknown>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    visible = true;
    held = new Set();
    send = vi.fn(() => Promise.resolve());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () =>
    createLiveReadAck({
      send,
      isVisible: () => visible,
      isHeld: (channelId) => held.has(channelId),
      delayMs: 1000,
    });

  it("acks once after a quiet second, however many messages arrived", () => {
    const ack = make();
    ack.note("c1");
    vi.advanceTimersByTime(500);
    ack.note("c1");
    ack.note("c1");
    vi.advanceTimersByTime(999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("c1");
  });

  it("does not ack while the page is hidden, and does once it shows", () => {
    const ack = make();
    visible = false;
    ack.note("c1");
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
    visible = true;
    ack.resume();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a Mark unread made after the arrival", () => {
    const ack = make();
    ack.note("c1");
    held.add("c1");
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
  });

  it("acks at once on leave, and only when something is waiting", () => {
    const ack = make();
    ack.flush("c1");
    expect(send).not.toHaveBeenCalled();
    ack.note("c1");
    ack.flush("c1");
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets the next open wait for an ack still in flight", async () => {
    let finish!: () => void;
    send.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const ack = make();
    ack.note("c1");
    ack.flush("c1");
    let settled = false;
    void ack.settled("c1").then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await ack.settled("c1");
    expect(settled).toBe(true);
  });
});

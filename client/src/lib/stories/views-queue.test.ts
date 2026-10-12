import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushStoryViews,
  pendingStoryViews,
  queueStoryViews,
  resetStoryViewsQueue,
} from "./views-queue";

afterEach(() => {
  resetStoryViewsQueue();
  vi.useRealTimers();
});

describe("story views queue", () => {
  it("batches views and sends them once", async () => {
    const send = vi.fn().mockResolvedValue({ recorded: 2 });
    resetStoryViewsQueue(send);
    queueStoryViews(["a", "b"]);
    queueStoryViews(["b"]);
    await flushStoryViews();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual(["a", "b"]);
    expect(pendingStoryViews()).toEqual([]);
  });

  it("a failed write puts the views back and retries them", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ recorded: 1 });
    resetStoryViewsQueue(send);
    queueStoryViews(["a"]);
    await flushStoryViews();
    expect(pendingStoryViews()).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(pendingStoryViews()).toEqual([]);
  });
});

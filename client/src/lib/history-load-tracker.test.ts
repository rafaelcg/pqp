import { describe, expect, it } from "vitest";
import { createHistoryLoadTracker } from "./history-load-tracker";

describe("createHistoryLoadTracker", () => {
  it("lets a lone request's failure stand", () => {
    const tracker = createHistoryLoadTracker();
    const load = tracker.begin();
    expect(load.failureStands()).toBe(true);
  });

  it("drops an old failure that settles after a newer request succeeded", () => {
    // Open A, switch away and back: the second open loads, then the first fails.
    const tracker = createHistoryLoadTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    second.succeeded();
    expect(first.failureStands()).toBe(false);
  });

  it("drops an old failure while a newer request is still pending", () => {
    const tracker = createHistoryLoadTracker();
    const first = tracker.begin();
    tracker.begin();
    expect(first.failureStands()).toBe(false);
  });

  it("drops the newest failure when an older request loaded since it started", () => {
    // A reconnect refetch starts during a retry, the retry loads, the
    // reconnect fails: the messages are on screen, so no error.
    const tracker = createHistoryLoadTracker();
    const retry = tracker.begin();
    const reconnect = tracker.begin();
    retry.succeeded();
    expect(reconnect.failureStands()).toBe(false);
  });

  it("lets a failure stand when the only success happened before it started", () => {
    const tracker = createHistoryLoadTracker();
    tracker.begin().succeeded();
    const retry = tracker.begin();
    expect(retry.failureStands()).toBe(true);
  });
});

describe("createHistoryLoadTracker reconnect refetch", () => {
  it("drops a pending open's failure when a reconnect refetch loaded the page", () => {
    const tracker = createHistoryLoadTracker();
    const open = tracker.begin();
    tracker.loaded();
    expect(open.failureStands()).toBe(false);
  });

  it("keeps a pending open's failure when the reconnect refetch did not load", () => {
    // The refetch fails silently; it must not hide the open's failure.
    const tracker = createHistoryLoadTracker();
    const open = tracker.begin();
    expect(open.failureStands()).toBe(true);
  });
});

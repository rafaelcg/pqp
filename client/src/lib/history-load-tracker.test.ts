import { describe, expect, it } from "vitest";
import { createHistoryLoadTracker } from "./history-load-tracker";

describe("createHistoryLoadTracker", () => {
  it("lets a lone request's failure stand", () => {
    const tracker = createHistoryLoadTracker();
    const load = tracker.begin("a");
    expect(load.failureStands()).toBe(true);
  });

  it("drops an old failure that settles after a newer request succeeded", () => {
    // Open A, switch away and back: the second open loads, then the first fails.
    const tracker = createHistoryLoadTracker();
    const first = tracker.begin("a");
    const second = tracker.begin("a");
    second.succeeded();
    expect(first.failureStands()).toBe(false);
  });

  it("drops an old failure while a newer request is still pending", () => {
    const tracker = createHistoryLoadTracker();
    const first = tracker.begin("a");
    tracker.begin("a");
    expect(first.failureStands()).toBe(false);
  });

  it("drops the newest failure when an older request loaded since it started", () => {
    // A reconnect refetch starts during a retry, the retry loads, the
    // reconnect fails: the messages are on screen, so no error.
    const tracker = createHistoryLoadTracker();
    const retry = tracker.begin("a");
    const reconnect = tracker.begin("a");
    retry.succeeded();
    expect(reconnect.failureStands()).toBe(false);
  });

  it("lets a failure stand when the only success happened before it started", () => {
    const tracker = createHistoryLoadTracker();
    tracker.begin("a").succeeded();
    const retry = tracker.begin("a");
    expect(retry.failureStands()).toBe(true);
  });
});

describe("createHistoryLoadTracker success ordering", () => {
  it("applies a lone success", () => {
    const tracker = createHistoryLoadTracker();
    expect(tracker.begin("a").succeeded()).toBe(true);
  });

  it("skips an old page that lands after a newer one for the same channel", () => {
    // Open A twice: the second answer lands first, then the first. Applying
    // the first would drop what arrived between the two reads.
    const tracker = createHistoryLoadTracker();
    const first = tracker.begin("a");
    const second = tracker.begin("a");
    expect(second.succeeded()).toBe(true);
    expect(first.succeeded()).toBe(false);
  });

  it("applies both when they land in the order they started", () => {
    const tracker = createHistoryLoadTracker();
    const first = tracker.begin("a");
    const second = tracker.begin("a");
    expect(first.succeeded()).toBe(true);
    expect(second.succeeded()).toBe(true);
  });

  it("skips an old page after leaving and coming back", () => {
    // A1 pending, open B, back to A (A3): A3 lands first, then A1.
    const tracker = createHistoryLoadTracker();
    const a1 = tracker.begin("a");
    expect(tracker.begin("b").succeeded()).toBe(true);
    const a3 = tracker.begin("a");
    expect(a3.succeeded()).toBe(true);
    expect(a1.succeeded()).toBe(false);
  });

  it("applies an old page for a channel opened again since its newer page", () => {
    // A1 pending, A2 on screen, B opened (the list is B's now), back to A:
    // A1 is the only page for A, and it beats an empty list.
    const tracker = createHistoryLoadTracker();
    const a1 = tracker.begin("a");
    expect(tracker.begin("a").succeeded()).toBe(true);
    tracker.begin("b");
    const a4 = tracker.begin("a");
    expect(a1.succeeded()).toBe(true);
    expect(a4.succeeded()).toBe(true);
  });

  it("counts a skipped page against a newer failure", () => {
    // A newer page is on screen either way, so the history is not unavailable.
    const tracker = createHistoryLoadTracker();
    const first = tracker.begin("a");
    expect(tracker.begin("a").succeeded()).toBe(true);
    const retry = tracker.begin("a");
    expect(first.succeeded()).toBe(false);
    expect(retry.failureStands()).toBe(false);
  });
});

describe("createHistoryLoadTracker reconnect refetch", () => {
  it("drops a pending open's failure when a reconnect refetch loaded the page", () => {
    const tracker = createHistoryLoadTracker();
    const open = tracker.begin("a");
    tracker.quiet("a").succeeded();
    expect(open.failureStands()).toBe(false);
  });

  it("keeps a pending open's failure when the reconnect refetch did not load", () => {
    // The refetch fails silently; it must not hide the open's failure.
    const tracker = createHistoryLoadTracker();
    const open = tracker.begin("a");
    tracker.quiet("a");
    expect(open.failureStands()).toBe(true);
  });

  it("skips an open's page when a later reconnect refetch already applied", () => {
    const tracker = createHistoryLoadTracker();
    const open = tracker.begin("a");
    expect(tracker.quiet("a").succeeded()).toBe(true);
    expect(open.succeeded()).toBe(false);
  });

  it("skips a reconnect page when a later retry already applied", () => {
    const tracker = createHistoryLoadTracker();
    const reconnect = tracker.quiet("a");
    expect(tracker.begin("a").succeeded()).toBe(true);
    expect(reconnect.succeeded()).toBe(false);
  });
});

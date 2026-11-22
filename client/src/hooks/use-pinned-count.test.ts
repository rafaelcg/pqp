import { afterEach, describe, expect, it } from "vitest";
import {
  pinSignatureOf,
  pinnedCountDropped,
  pinnedCountOf,
  resetPinnedCountsForTests,
  setPinnedCount,
} from "./use-pinned-count";

describe("pinSignatureOf", () => {
  it("changes when a pin lands, again when the server confirms it, and on an unpin", () => {
    const none = pinSignatureOf([{ id: "a" }, { id: "b", pinnedAt: null }]);
    const optimistic = pinSignatureOf([{ id: "a", pinnedAt: "t", pinnedBy: null }, { id: "b" }]);
    const confirmed = pinSignatureOf([{ id: "a", pinnedAt: "t", pinnedBy: { id: "u" } }, { id: "b" }]);
    expect(none).toBe("");
    expect(optimistic).not.toBe(none);
    expect(confirmed).not.toBe(optimistic);
    expect(pinSignatureOf([{ id: "a", pinnedAt: null }, { id: "b" }])).toBe(none);
  });
});

describe("the shared pinned count", () => {
  afterEach(resetPinnedCountsForTests);

  it("is unknown until somebody reads the list, per channel", () => {
    expect(pinnedCountOf("c1")).toBeNull();
    expect(pinnedCountOf(null)).toBeNull();
    setPinnedCount("c1", 3);
    expect(pinnedCountOf("c1")).toBe(3);
    expect(pinnedCountOf("c2")).toBeNull();
  });

  // The panel unpins a message older than the loaded window: the header's
  // own fetch never runs again for it, so the panel says so here.
  it("drops by one for an unpin made from the panel", () => {
    setPinnedCount("c1", 3);
    pinnedCountDropped("c1");
    expect(pinnedCountOf("c1")).toBe(2);
  });

  it("does not invent a count, or go below zero", () => {
    pinnedCountDropped("c1");
    expect(pinnedCountOf("c1")).toBeNull();
    setPinnedCount("c1", 0);
    pinnedCountDropped("c1");
    expect(pinnedCountOf("c1")).toBe(0);
  });
});

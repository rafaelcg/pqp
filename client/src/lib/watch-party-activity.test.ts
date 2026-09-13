import { describe, expect, it } from "vitest";
import { newHands, pushActivity } from "./watch-party-activity";

describe("watch party activity", () => {
  it("keeps newest first and caps the feed", () => {
    let feed = pushActivity([], { kind: "audience", delta: 1, total: 1 }, 1, 3);
    feed = pushActivity(feed, { kind: "audience", delta: 1, total: 2 }, 2, 3);
    feed = pushActivity(feed, { kind: "audience", delta: 1, total: 3 }, 3, 3);
    feed = pushActivity(feed, { kind: "audience", delta: 1, total: 4 }, 4, 3);
    expect(feed).toHaveLength(3);
    expect(feed[0]?.at).toBe(4);
    expect(feed[2]?.at).toBe(2);
  });

  it("reports only the hands that were not up before", () => {
    const a = { userId: "a", displayName: "A", avatarUrl: null };
    const b = { userId: "b", displayName: "B", avatarUrl: null };
    expect(newHands([a], [a, b])).toEqual([b]);
    expect(newHands([a, b], [b])).toEqual([]);
  });
});

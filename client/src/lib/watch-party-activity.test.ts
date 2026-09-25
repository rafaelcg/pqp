import { describe, expect, it } from "vitest";
import { feedAudienceCount, newHands, pushActivity } from "./watch-party-activity";

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

  it("does not know the audience before the first channel-live, and never counts the presenter", () => {
    // Production rehearsal C, 2026-09-25: a presenter who reloaded mid-party
    // got three "+1 assistindo" lines in a minute with one real viewer. The
    // feed took "no frame yet" as 0 (the first line), and the returning
    // presenter, seated under a new peer id while the stream still named the
    // old one, counted as a viewer (the other two).
    expect(feedAudienceCount(undefined, undefined)).toBeNull();
    const HOST = "00000000-0000-4000-8000-00000000000a";
    const live = {
      stream: {
        hlsUrl: "/api/voice/hls-playlist/c1/1",
        startedAt: 1,
        presenterPeerId: "old-peer",
        presenterUserId: HOST,
      },
      watching: 1,
    };
    const back = [{ peerId: "new-peer", sharingScreen: false, userId: HOST }];
    expect(feedAudienceCount(live, back)).toBe(1);
    expect(feedAudienceCount({ stream: null, watching: 0, streamEnded: true }, back)).toBe(0);
  });
});

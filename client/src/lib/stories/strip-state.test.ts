import { describe, expect, it } from "vitest";
import type { StoryStrip, StoryStripItem } from "@pqp/shared";
import {
  canApplyStripNow,
  isStripItemLive,
  msUntilNextExpiry,
  stripView,
  visibleStripItems,
} from "./strip-state";

const NOW = Date.parse("2026-10-11T20:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function item(id: string, expiresInMinutes: number, unseen = true, storyIds = [`${id}-1`]): StoryStripItem {
  return {
    author: { id, displayName: id, avatarUrl: null, handle: null },
    storyIds,
    latestAt: at(-10),
    expiresAt: at(expiresInMinutes),
    unseen,
    hasCall: false,
  };
}

function strip(patch: Partial<StoryStrip>): StoryStrip {
  return { enabled: true, canPost: true, own: null, items: [], firstRunHint: false, ...patch };
}

describe("expiry is local", () => {
  it("a ring whose newest story expired is gone, without a frame", () => {
    expect(isStripItemLive(item("a", 1), NOW)).toBe(true);
    expect(isStripItemLive(item("a", 0), NOW)).toBe(false);
    expect(visibleStripItems([item("a", 5), item("b", -1)], NOW, new Set()).map((i) => i.author.id)).toEqual(["a"]);
  });

  it("the timer is armed for the next expiry, own ring included", () => {
    const delay = msUntilNextExpiry(strip({ items: [item("a", 30)], own: item("me", 2) }), NOW);
    expect(delay).toBe(2 * 60_000 + 50);
  });

  it("no timer when nothing will expire, and never a 0 ms loop", () => {
    expect(msUntilNextExpiry(strip({}), NOW)).toBeNull();
    expect(msUntilNextExpiry(strip({ items: [item("a", 0.001)] }), NOW)).toBe(250);
  });
});

describe("order and seen", () => {
  it("never reorders: a watched author keeps their place and only greys out", () => {
    const items = [item("a", 60, true), item("b", 60, true, ["b-1", "b-2"]), item("c", 60, false)];
    const shown = visibleStripItems(items, NOW, new Set(["b-1", "b-2"]));
    expect(shown.map((i) => i.author.id)).toEqual(["a", "b", "c"]);
    expect(shown.map((i) => i.unseen)).toEqual([true, false, false]);
  });

  it("an author is seen only once every story of theirs was watched", () => {
    const shown = visibleStripItems([item("b", 60, true, ["b-1", "b-2"])], NOW, new Set(["b-1"]));
    expect(shown[0]!.unseen).toBe(true);
  });

  it("a refetch that reorders waits while the pointer is on the strip", () => {
    const current = strip({ items: [item("a", 60), item("b", 60)] });
    const reordered = strip({ items: [item("b", 60), item("a", 60)] });
    const sameOrder = strip({ items: [item("a", 60, false), item("b", 60)] });
    expect(canApplyStripNow(current, reordered, true)).toBe(false);
    expect(canApplyStripNow(current, reordered, false)).toBe(true);
    expect(canApplyStripNow(current, sameOrder, true)).toBe(true);
    expect(canApplyStripNow(current, strip({ items: [item("a", 60)] }), true)).toBe(false);
    expect(canApplyStripNow(null, reordered, true)).toBe(true);
  });
});

describe("which face the strip shows", () => {
  const base = { now: NOW, seenIds: new Set<string>(), firstRunDismissed: false };

  it("flag off: nothing, whatever else the answer says", () => {
    expect(stripView(strip({ enabled: false, items: [item("a", 60)] }), base).kind).toBe("hidden");
  });

  it("a live ring, own or anybody's, draws the strip", () => {
    expect(stripView(strip({ items: [item("a", 60)] }), base).kind).toBe("strip");
    const own = stripView(strip({ own: item("me", 60) }), base);
    expect(own.kind === "strip" && own.own?.author.id).toBe("me");
  });

  it("an empty strip costs no row", () => {
    expect(stripView(strip({}), base).kind).toBe("hidden");
  });

  it("only expired rings: hidden, not an empty strip", () => {
    expect(stripView(strip({ items: [item("a", -5)], own: item("me", -1) }), base).kind).toBe("hidden");
  });

  it("first run: only when the server says so, the viewer may post, and it was not dismissed", () => {
    expect(stripView(strip({ firstRunHint: true }), base).kind).toBe("first-run");
    expect(stripView(strip({ firstRunHint: true, canPost: false }), base).kind).toBe("hidden");
    expect(stripView(strip({ firstRunHint: true }), { ...base, firstRunDismissed: true }).kind).toBe(
      "hidden",
    );
    expect(stripView(strip({ firstRunHint: true, items: [item("a", 60)] }), base).kind).toBe("strip");
  });
});

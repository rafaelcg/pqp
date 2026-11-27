import { describe, expect, it } from "vitest";
import {
  FEATURED_HALF_LIFE_DAYS,
  distinctPeople,
  featuredScore,
  isFeaturable,
  pickFeatured,
  pickWantingParts,
  takesParts,
} from "./featured";

type Mode = "open" | "wanted" | "closed";
const NOW = Date.parse("2026-11-27T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

interface Over {
  parts?: number;
  people?: number;
  cover?: string | null;
  plays?: number;
  likes?: number;
  age?: number;
  by?: { name: string; handle: string | null };
}

/** A song that has earned the slot unless `over` says otherwise: a cover, two parts, two people. */
const s = (id: string, artist: string | null, parts = 2, joinMode: Mode = "open", over: Over = {}) => {
  const people = over.people ?? Math.min(parts, 2);
  return {
    id,
    artist,
    joinMode,
    coverUrl: over.cover === undefined ? `/cover/${id}.jpg` : over.cover,
    plays: over.plays ?? 0,
    likes: over.likes ?? 0,
    publishedAt: daysAgo(over.age ?? 1),
    startedBy: { avatarUrl: null, ...(over.by ?? { name: "Starter", handle: "starter" }) },
    parts: Array.from({ length: parts }, (_, index) => ({
      instrument: "guitar",
      hasVideo: false,
      person: { name: `P${index % Math.max(1, people)}`, handle: null, avatarUrl: null },
    })) as never[],
  };
};
const pick = (songs: ReturnType<typeof s>[], options = {}) => pickFeatured(songs, { now: NOW, ...options });

describe("takesParts", () => {
  it("is false only for a closed song, and true when the field is absent (an older server)", () => {
    expect(takesParts({ joinMode: "open" })).toBe(true);
    expect(takesParts({ joinMode: "wanted" })).toBe(true);
    expect(takesParts({ joinMode: "closed" })).toBe(false);
    expect(takesParts({} as { joinMode: "open" })).toBe(true);
  });
});

describe("distinctPeople", () => {
  it("counts a handle once however many parts it has, and tells two namesakes apart by picture", () => {
    const part = (name: string, handle: string | null, avatarUrl: string | null = null) => ({ person: { name, handle, avatarUrl } });
    expect(distinctPeople({ parts: [part("A", "a"), part("A2", "a")] } as never)).toBe(1);
    expect(distinctPeople({ parts: [part("Ana", null, "x.png"), part("Ana", null, "y.png")] } as never)).toBe(2);
    expect(distinctPeople({ parts: [part("Ana", null), part("Ana", null)] } as never)).toBe(1);
  });
});

describe("isFeaturable: a song must earn the slot", () => {
  it("accepts a song with a cover and two parts from two people", () => {
    expect(isFeaturable(s("ok", null))).toBe(true);
  });
  it("refuses a song with no cover (null or empty)", () => {
    expect(isFeaturable(s("a", null, 2, "open", { cover: null }))).toBe(false);
    expect(isFeaturable(s("b", null, 2, "open", { cover: "" }))).toBe(false);
  });
  it("refuses a one-part song, and a song with no part", () => {
    expect(isFeaturable(s("a", null, 1))).toBe(false);
    expect(isFeaturable(s("b", null, 0))).toBe(false);
  });
  it("refuses two parts from the same person: a band of one is a draft", () => {
    expect(isFeaturable(s("a", null, 3, "open", { people: 1 }))).toBe(false);
  });
  it("refuses an excluded id", () => {
    expect(isFeaturable(s("a", null), { exclude: new Set(["a"]) })).toBe(false);
    expect(isFeaturable(s("a", null), { exclude: new Set(["other"]) })).toBe(true);
  });
  it("refuses the viewer's own song from the last day by HANDLE, and accepts it later", () => {
    const mine = (age: number) => s("mine", null, 2, "open", { age, by: { name: "Rafa Silva", handle: "rafa" } });
    expect(isFeaturable(mine(0.2), { now: NOW, viewer: { handle: "Rafa" } })).toBe(false);
    expect(isFeaturable(mine(3), { now: NOW, viewer: { handle: "rafa" } })).toBe(true);
    expect(isFeaturable(mine(0.2), { now: NOW, viewer: { handle: "someone" } })).toBe(true);
    expect(isFeaturable(mine(0.2), { now: NOW, viewer: { handle: null } })).toBe(true);
    expect(isFeaturable(mine(0.2), { now: NOW, viewer: null })).toBe(true);
  });
  it("never drops another person's song because they share a display name or a first name with the viewer", () => {
    const stranger = s("stranger", null, 2, "open", { age: 0.2, by: { name: "Alex Rivera", handle: null } });
    const sameName = s("same", null, 2, "open", { age: 0.2, by: { name: "Rafa", handle: "rafa2" } });
    expect(isFeaturable(stranger, { now: NOW, viewer: { handle: "alex" } })).toBe(true);
    expect(isFeaturable(sameName, { now: NOW, viewer: { handle: "rafa" } })).toBe(true);
    // a viewer with no handle identifies nobody: nothing is excluded
    expect(isFeaturable(stranger, { now: NOW, viewer: {} })).toBe(true);
  });
  it("hidden and reported songs are the server's to leave out: they never reach the payload", () => {
    // Nothing in the payload names them, so nothing here can: this pins that no flag is read.
    expect(Object.keys(s("a", null)).some((key) => /hidden|report|removed/i.test(key))).toBe(false);
  });
});

describe("featuredScore", () => {
  it("is plays plus five times the likes on the day a song is published", () => {
    expect(featuredScore({ plays: 10, likes: 2, publishedAt: daysAgo(0) }, NOW)).toBeCloseTo(20);
  });
  it("halves every half-life", () => {
    const fresh = featuredScore({ plays: 100, likes: 0, publishedAt: daysAgo(0) }, NOW);
    const later = featuredScore({ plays: 100, likes: 0, publishedAt: daysAgo(FEATURED_HALF_LIFE_DAYS) }, NOW);
    expect(later).toBeCloseTo(fresh / 2);
  });
  it("is zero, never NaN, with no counters or a bad date, and ignores a date in the future", () => {
    expect(featuredScore({}, NOW)).toBe(0);
    expect(featuredScore({ plays: 5, publishedAt: "not a date" }, NOW)).toBe(5);
    expect(featuredScore({ plays: 5, publishedAt: daysAgo(-3) }, NOW)).toBe(5);
    expect(featuredScore({ plays: -4, likes: -1 }, NOW)).toBe(0);
  });
});

describe("pickFeatured", () => {
  it("prefers an original over a more engaged cover", () => {
    expect(pick([s("cover", "Some Band", 2, "open", { plays: 900 }), s("orig", null)])?.id).toBe("orig");
  });
  it("is the song with a part when every song is a cover", () => {
    expect(pick([s("empty", "A", 0), s("one", "B", 1), s("two", "C")])?.id).toBe("two");
  });
  it("skips an original with no part to show", () => {
    expect(pick([s("bare", null, 0), s("cover", "A"), s("orig", null)])?.id).toBe("orig");
  });
  it("is null with nothing to show", () => {
    expect(pick([])).toBeNull();
    expect(pick([s("bare", null, 0)])).toBeNull();
  });

  it("passes over a closed original for an original that takes a part, even further down", () => {
    expect(pick([s("closed", null, 2, "closed"), s("cover", "A"), s("wanted", null, 2, "wanted")])?.id).toBe("wanted");
  });
  it("prefers a closed original to an open cover (the cover is the rights risk)", () => {
    expect(pick([s("cover", "A"), s("closed", null, 2, "closed")])?.id).toBe("closed");
  });
  it("with no original, passes over a closed cover for one that takes a part", () => {
    expect(pick([s("closed", "A", 2, "closed"), s("open", "B")])?.id).toBe("open");
  });
  it("with only closed covers, takes one of them", () => {
    expect(pick([s("a", "A", 2, "closed"), s("b", "B", 2, "closed")])?.id).toBe("a");
  });

  it("is null when nothing earned the slot: a lone, coverless, one-part upload is never the front page", () => {
    const rough = s("rough", null, 1, "open", { cover: null, age: 0 });
    expect(pick([rough])).toBeNull();
    expect(pick([rough, s("nocover", null, 2, "open", { cover: null }), s("solo", null, 1), s("band-of-one", null, 3, "open", { people: 1 })])).toBeNull();
  });
  it("passes over weak songs that rank higher in Em alta for the first that earned it", () => {
    expect(pick([s("weak", null, 1, "open", { cover: null, likes: 50 }), s("good", null)])?.id).toBe("good");
  });
  it("the newest song does not win by being newest", () => {
    const newest = s("newest", null, 2, "open", { age: 0, plays: 1 });
    const older = s("older", null, 2, "open", { age: 5, plays: 300, likes: 20 });
    expect(pick([newest, older])?.id).toBe("older");
  });
  it("breaks a tie inside a preference class by engagement over the recent past, then by the page's order", () => {
    const fresh = s("fresh", null, 2, "open", { age: 1, plays: 60 });
    const stale = s("stale", null, 2, "open", { age: 90, plays: 400, likes: 40 });
    expect(pick([stale, fresh])?.id).toBe("fresh");
    const a = s("a", null, 2, "open", { plays: 10 });
    const b = s("b", null, 2, "open", { plays: 10 });
    expect(pick([a, b])?.id).toBe("a");
    expect(pick([b, a])?.id).toBe("b");
  });
  it("engagement never overrides the preference: a quiet open original beats a viral open cover, and a viral closed original loses to a quiet one that takes a part", () => {
    expect(pick([s("viral-cover", "X", 2, "open", { plays: 5000 }), s("quiet-original", null)])?.id).toBe("quiet-original");
    expect(pick([s("viral-closed", null, 2, "closed", { plays: 5000 }), s("quiet-open", null)])?.id).toBe("quiet-open");
  });
  it("never features the viewer's own song from the last day, and falls to the next that earned it", () => {
    const own = s("own", null, 2, "open", { age: 0.1, plays: 99, by: { name: "Rafa", handle: "rafa" } });
    expect(pick([own, s("other", null)], { viewer: { handle: "rafa" } })?.id).toBe("other");
    expect(pick([own], { viewer: { handle: "rafa" } })).toBeNull();
  });
  it("honours an exclusion list", () => {
    expect(pick([s("a", null), s("b", null)], { exclude: new Set(["a"]) })?.id).toBe("b");
  });
});

describe("pickWantingParts", () => {
  const w = (id: string, joinMode: Mode, needs: string[] = [], parts = 1) => ({
    id,
    joinMode,
    needs: needs as never[],
    parts: Array.from({ length: parts }, () => ({})) as never[],
  });

  it("is empty when the hero takes a part, or there is no hero", () => {
    expect(pickWantingParts([w("a", "wanted", ["bass"])], { id: "h", joinMode: "open" })).toEqual([]);
    expect(pickWantingParts([w("a", "wanted", ["bass"])], { id: "h", joinMode: "wanted" })).toEqual([]);
    expect(pickWantingParts([w("a", "wanted", ["bass"])], null)).toEqual([]);
  });
  it("is empty when no other song takes a part", () => {
    expect(pickWantingParts([w("h", "closed"), w("c", "closed"), w("e", "open", [], 0)], { id: "h", joinMode: "closed" })).toEqual([]);
  });
  it("leaves out a wanted song with nothing missing: it takes only listed instruments the payload does not name", () => {
    const hero = w("h", "closed");
    expect(pickWantingParts([hero, w("filled", "wanted", [])], hero)).toEqual([]);
    expect(pickWantingParts([hero, w("filled", "wanted", []), w("open", "open")], hero).map((song) => song.id)).toEqual(["open"]);
  });
  it("lists songs that ask for an instrument first, then open ones, never the hero or a closed one, at most three", () => {
    const hero = w("h", "closed");
    const list = [hero, w("open1", "open"), w("c", "closed"), w("ask1", "wanted", ["bass"]), w("ask2", "wanted", ["keys"]), w("ask3", "wanted", ["drums"]), w("open2", "open")];
    expect(pickWantingParts(list, hero).map((song) => song.id)).toEqual(["ask1", "ask2", "ask3"]);
    expect(pickWantingParts(list, hero, 5).map((song) => song.id)).toEqual(["ask1", "ask2", "ask3", "open1", "open2"]);
  });
});

import { describe, expect, it } from "vitest";
import { acquisitionFromLocation, peekAcquisition, rememberAcquisitionFromLocation } from "./acquisition";
import {
  JAM_ATTRIBUTION_TTL_MS,
  JAM_INTENT_TTL_MS,
  currentJamAttribution,
  jamAttributionFromSearch,
  jamAttributionQuery,
  jamIntentFromSearch,
  jamMainHref,
  rememberJamAttribution,
  jamIntentHref,
  jamReturnPath,
  peekJamIntent,
  rememberJamIntentFromLocation,
  stashJamIntent,
  takeJamIntent,
} from "./jam-intent";

const ID = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

describe("the URL", () => {
  it("reads a song, a recording and a new jam", () => {
    expect(jamIntentFromSearch(`?jam=${ID}`)).toEqual({
      kind: "song",
      songId: ID,
      record: false,
      instrument: null,
      act: null,
      trackId: null,
    });
    expect(jamIntentFromSearch(`?jam=${ID}&record=1&instrument=bass`)).toEqual({
      kind: "song",
      songId: ID,
      record: true,
      instrument: "bass",
      act: null,
      trackId: null,
    });
    expect(jamIntentFromSearch("?jam=new")).toEqual({ kind: "new" });
  });

  it("carries a like and a report, and the part a report names", () => {
    const track = "5c4b3a29-1807-4f6e-9d5c-3b2a19087f6e";
    expect(jamIntentFromSearch(`?jam=${ID}&act=like`)).toMatchObject({ act: "like", trackId: null });
    expect(jamIntentFromSearch(`?jam=${ID}&act=report&track=${track}`)).toMatchObject({ act: "report", trackId: track });
    // a track means nothing without a report, and a bad one is dropped
    expect(jamIntentFromSearch(`?jam=${ID}&act=like&track=${track}`)).toMatchObject({ trackId: null });
    expect(jamIntentFromSearch(`?jam=${ID}&act=report&track=nope`)).toMatchObject({ act: "report", trackId: null });
    const intent = { kind: "song", songId: ID, record: false, instrument: null, act: "report", trackId: track } as const;
    expect(jamIntentFromSearch(new URL(jamIntentHref(intent), "https://x").search)).toEqual(intent);
    const storage = memory();
    stashJamIntent(storage, intent);
    expect(takeJamIntent(storage)).toEqual(intent);
  });

  it("refuses anything that is not our shape", () => {
    expect(jamIntentFromSearch("")).toBeNull();
    expect(jamIntentFromSearch("?jam=nope")).toBeNull();
    expect(jamIntentFromSearch(`?jam=${ID}x`)).toBeNull();
    // An instrument we do not know is no instrument, and without record it is dropped.
    expect(jamIntentFromSearch(`?jam=${ID}&record=1&instrument=kazoo`)).toMatchObject({
      record: true,
      instrument: null,
    });
    expect(jamIntentFromSearch(`?jam=${ID}&instrument=bass`)).toMatchObject({ instrument: null });
  });

  it("writes the app URL a sign-up button points at, and it reads back", () => {
    const intent = { kind: "song", songId: ID, record: true, instrument: "keys", act: null, trackId: null } as const;
    const href = jamIntentHref(intent, "https://pqp.gg");
    // No `ref` on the site's own address: the hand-over says `ref=jam`.
    expect(href).toBe(`https://pqp.gg/app?jam=${ID}&record=1&instrument=keys&ref=jam`);
    expect(jamIntentFromSearch(new URL(href).search)).toEqual(intent);
    expect(jamIntentHref({ kind: "new" })).toBe("/app?jam=new&ref=jam");
  });

  it("names where the app sends somebody back to", () => {
    expect(jamReturnPath({ kind: "song", songId: ID, record: true, instrument: "bass" })).toBe(
      `/jam/m/${ID}?from=app&record=1&instrument=bass`,
    );
    expect(jamReturnPath({ kind: "new" })).toBe("/jam?from=app&jam=new");
  });
});

describe("the stash", () => {
  it("survives until it is taken, once", () => {
    const storage = memory();
    stashJamIntent(storage, { kind: "song", songId: ID, record: true, instrument: "drums" });
    expect(peekJamIntent(storage)).toMatchObject({ songId: ID, instrument: "drums" });
    expect(peekJamIntent(storage)).not.toBeNull();
    expect(takeJamIntent(storage)).toMatchObject({ record: true });
    expect(takeJamIntent(storage)).toBeNull();
  });

  it("expires after an hour", () => {
    const storage = memory();
    stashJamIntent(storage, { kind: "new" }, 1000);
    expect(peekJamIntent(storage, 1000 + JAM_INTENT_TTL_MS)).toEqual({ kind: "new" });
    expect(peekJamIntent(storage, 1001 + JAM_INTENT_TTL_MS)).toBeNull();
  });

  it("ignores a hand-edited value", () => {
    const storage = memory();
    storage.setItem("pqp:pending-jam", "{not json");
    expect(peekJamIntent(storage)).toBeNull();
    storage.setItem("pqp:pending-jam", JSON.stringify({ value: "../etc", at: Date.now() }));
    expect(takeJamIntent(storage)).toBeNull();
  });

  it("does nothing, and does not throw, when storage is denied", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => stashJamIntent(denied, { kind: "new" })).not.toThrow();
    expect(takeJamIntent(denied)).toBeNull();
    expect(peekJamIntent(null)).toBeNull();
  });

  it("is written at boot from the URL", () => {
    const storage = memory();
    rememberJamIntentFromLocation(storage, { search: `?jam=${ID}&record=1` });
    expect(peekJamIntent(storage)).toMatchObject({ songId: ID, record: true });
    const other = memory();
    rememberJamIntentFromLocation(other, { search: "?claim=rafa" });
    expect(peekJamIntent(other)).toBeNull();
  });
});

describe("a copyright report asked for by a link", () => {
  const track = "5c4b3a29-1807-4f6e-9d5c-3b2a19087f6e";

  it("carries the reason on a song and on a part, through the URL and the stash", () => {
    for (const trackId of [null, track]) {
      const intent = { kind: "song", songId: ID, record: false, instrument: null, act: "report", trackId, reason: "copyright" } as const;
      const href = jamIntentHref(intent, "https://pqp.gg");
      expect(href).toContain("reason=copyright");
      expect(jamIntentFromSearch(new URL(href).search)).toEqual(intent);
      const storage = memory();
      stashJamIntent(storage, intent);
      expect(takeJamIntent(storage)).toEqual(intent);
    }
  });

  it("means nothing without a report, and nothing but copyright is accepted", () => {
    expect(jamIntentFromSearch(`?jam=${ID}&act=like&reason=copyright`)).not.toHaveProperty("reason");
    expect(jamIntentFromSearch(`?jam=${ID}&act=report&reason=spam`)).not.toHaveProperty("reason");
    expect(jamIntentFromSearch(`?jam=${ID}&record=1&reason=copyright`)).not.toHaveProperty("reason");
  });
});

describe("attribution through the hand-over", () => {
  const intent = { kind: "song", songId: ID, record: true, instrument: null, act: null, trackId: null } as const;

  it("says ref=jam when the site was opened with no ref", () => {
    expect(jamAttributionQuery(null)).toBe("ref=jam");
    expect(jamAttributionQuery({ utm_source: "newsletter" })).toBe("ref=jam&utm_source=newsletter");
    expect(jamIntentHref(intent, "https://pqp.gg", null)).toContain("&ref=jam");
  });

  it("forwards ref and utm_*, and nothing else from the address", () => {
    const found = jamAttributionFromSearch(
      "?ref=clip-ana&utm_source=tiktok&utm_medium=social&utm_campaign=jam-nov&gclid=abc&fbclid=x&jam=new&extra=1",
    );
    expect(found).toEqual({ ref: "clip-ana", utm_source: "tiktok", utm_medium: "social", utm_campaign: "jam-nov" });
    const href = jamIntentHref(intent, "https://pqp.gg", found);
    const search = new URL(href).searchParams;
    expect(search.get("ref")).toBe("clip-ana");
    expect(search.get("utm_source")).toBe("tiktok");
    expect(search.get("utm_medium")).toBe("social");
    expect(search.get("utm_campaign")).toBe("jam-nov");
    expect(search.has("gclid")).toBe(false);
    expect(search.has("fbclid")).toBe(false);
    expect(search.has("extra")).toBe(false);
    // the intent is untouched by the extra parameters
    expect(jamIntentFromSearch(new URL(href).search)).toEqual(intent);
  });

  it("bounds and cleans what it forwards", () => {
    expect(jamAttributionFromSearch("?ref=")).toBeNull();
    expect(jamAttributionFromSearch("?nothing=here")).toBeNull();
    expect(jamAttributionFromSearch(`?ref=${"x".repeat(300)}`)?.ref).toHaveLength(100);
    expect(jamAttributionFromSearch("?ref=a%0Ab%09c")?.ref).toBe("a b c");
  });

  it("lands in the app's acquisition stash from the very URL the hand-over writes", () => {
    const href = jamIntentHref(intent, "https://pqp.gg", { ref: "clip-ana", utm_source: "tiktok" });
    const url = new URL(href);
    expect(acquisitionFromLocation(url.search, url.pathname)).toMatchObject({
      ref: "clip-ana",
      source: "tiktok",
      landing: "/app",
    });
    // and the default: no ref on the site, ref=jam in the report
    const plain = new URL(jamIntentHref(intent, "https://pqp.gg"));
    const storage = memory();
    rememberAcquisitionFromLocation(storage, plain);
    expect(peekAcquisition(storage)).toMatchObject({ ref: "jam" });
  });

  it("keeps the arrival's parameters for the sign-up button, first touch, for 30 days", () => {
    const storage = memory();
    const t0 = 1_000_000;
    rememberJamAttribution(storage, "?ref=clip-ana&utm_source=tiktok", t0);
    // the site moved on with pushState: the address no longer says it, the stash does
    expect(currentJamAttribution(storage, "", t0 + 1000)).toEqual({ ref: "clip-ana", utm_source: "tiktok" });
    // a second explicit arrival changes nothing
    rememberJamAttribution(storage, "?ref=clip-bo", t0 + 2000);
    expect(currentJamAttribution(storage, "", t0 + 3000)?.ref).toBe("clip-ana");
    // an arrival with no parameters writes nothing (the default is applied when the link is built)
    const empty = memory();
    rememberJamAttribution(empty, "?jam=new", t0);
    expect(currentJamAttribution(empty, "", t0)).toBeNull();
    // the current address is the fallback when nothing is stashed
    expect(currentJamAttribution(empty, "?ref=late", t0)).toEqual({ ref: "late" });
    // expired
    expect(currentJamAttribution(storage, "", t0 + JAM_ATTRIBUTION_TTL_MS + 1)).toBeNull();
    // hand-edited junk is no attribution
    const junk = memory();
    junk.setItem("pqp:jam-attribution", "{nope");
    expect(currentJamAttribution(junk, "", t0)).toBeNull();
  });

  it("does nothing, and does not throw, when storage is denied", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => rememberJamAttribution(denied, "?ref=x")).not.toThrow();
    expect(currentJamAttribution(denied, "?ref=x")).toEqual({ ref: "x" });
    expect(currentJamAttribution(null, "")).toBeNull();
  });

  it("keeps the attribution on a plain link to the main site", () => {
    expect(jamMainHref("/app", "https://pqp.gg", null)).toBe("https://pqp.gg/app?ref=jam");
    expect(jamMainHref("/c/ensaio", "https://pqp.gg", { ref: "clip-ana" })).toBe("https://pqp.gg/c/ensaio?ref=clip-ana");
    expect(jamMainHref("/", "", null)).toBe("/?ref=jam");
  });
});

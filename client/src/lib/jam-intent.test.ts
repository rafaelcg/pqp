import { describe, expect, it } from "vitest";
import {
  JAM_INTENT_TTL_MS,
  jamIntentFromSearch,
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
    expect(href).toBe(`https://pqp.gg/app?jam=${ID}&record=1&instrument=keys`);
    expect(jamIntentFromSearch(new URL(href).search)).toEqual(intent);
    expect(jamIntentHref({ kind: "new" })).toBe("/app?jam=new");
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

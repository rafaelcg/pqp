import { beforeEach, describe, expect, it } from "vitest";
import {
  ACQUISITION_KEY,
  ACQUISITION_TTL_MS,
  acquisitionFromLocation,
  rememberAcquisitionFromLocation,
  stashAcquisition,
  takeAcquisition,
} from "./acquisition";

/**
 * The attribution stash. What is pinned here is the same contract the handle
 * intents have, plus one rule of its own: FIRST TOUCH. A value that fires twice
 * sends two requests for one signup (the server would ignore the second, but
 * the client should not be relying on that), and a value that gets overwritten
 * credits the last link somebody clicked rather than the one that found them.
 */

function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage & { map: Map<string, string> };
}

/** Safari private mode, an embedded webview: every call throws. */
const hostileStorage = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
  removeItem() {
    throw new Error("denied");
  },
} as unknown as Storage;

describe("acquisitionFromLocation", () => {
  it("reads the UTM trio, gclid and ref, and records the landing path", () => {
    expect(
      acquisitionFromLocation(
        "?utm_source=google&utm_medium=cpc&utm_campaign=tela-br&gclid=abc123",
        "/tela",
      ),
    ).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "tela-br",
      gclid: "abc123",
      landing: "/tela",
    });
    expect(acquisitionFromLocation("?ref=newsletter", "/")).toEqual({
      ref: "newsletter",
      landing: "/",
    });
  });

  it("answers null when the URL carries no campaign at all", () => {
    // `add`, `claim` and `join` are intents, not attribution; `lang` is
    // negotiation. None of them is a reason to write anything.
    for (const search of ["", "?lang=pt-BR", "?add=rafa&claim=x", "?utm_source="]) {
      expect(acquisitionFromLocation(search, "/tela")).toBeNull();
    }
  });

  it("trims and bounds every value, since the query string is user-writable", () => {
    const long = "x".repeat(500);
    const result = acquisitionFromLocation(
      `?utm_source=%20google%20&gclid=${long}&utm_campaign=${long}`,
      "/",
    )!;
    expect(result.source).toBe("google");
    expect(result.gclid).toHaveLength(200);
    expect(result.campaign).toHaveLength(100);
  });
});

describe("the acquisition stash", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("survives the round trip and is consumed, so it is sent exactly once", () => {
    stashAcquisition(storage, { source: "google", landing: "/tela" });
    expect(takeAcquisition(storage)).toEqual({ source: "google", landing: "/tela" });
    expect(takeAcquisition(storage)).toBeNull();
    expect(storage.map.has(ACQUISITION_KEY)).toBe(false);
  });

  it("keeps the first touch and ignores every later one", () => {
    const now = Date.now();
    stashAcquisition(storage, { source: "google", campaign: "a" }, now);
    stashAcquisition(storage, { source: "meta", campaign: "b" }, now + 1000);
    rememberAcquisitionFromLocation(
      storage,
      { search: "?utm_source=tiktok", pathname: "/" },
      now + 2000,
    );
    expect(takeAcquisition(storage, now + 3000)).toEqual({
      source: "google",
      campaign: "a",
    });
  });

  it("expires after thirty days, and an expired entry no longer blocks a new one", () => {
    const now = Date.now();
    stashAcquisition(storage, { source: "google" }, now);
    expect(takeAcquisition(storage, now + ACQUISITION_TTL_MS - 1)).toEqual({
      source: "google",
    });

    stashAcquisition(storage, { source: "google" }, now);
    expect(takeAcquisition(storage, now + ACQUISITION_TTL_MS + 1)).toBeNull();

    stashAcquisition(storage, { source: "old" }, now);
    stashAcquisition(storage, { source: "new" }, now + ACQUISITION_TTL_MS + 1);
    expect(takeAcquisition(storage, now + ACQUISITION_TTL_MS + 2)).toEqual({
      source: "new",
    });
  });

  it("stores nothing for a null acquisition", () => {
    stashAcquisition(storage, null);
    rememberAcquisitionFromLocation(storage, { search: "", pathname: "/" });
    expect(storage.map.size).toBe(0);
  });

  it("reads anything unparseable as no record, and clears it on take", () => {
    for (const junk of [
      "",
      "not json",
      "[]",
      '{"source":"x"}',
      '{"at":"yesterday"}',
      '{"at":1,"source":42}',
      `{"at":${Date.now()}}`,
    ]) {
      storage.map.set(ACQUISITION_KEY, junk);
      expect(takeAcquisition(storage)).toBeNull();
      expect(storage.map.has(ACQUISITION_KEY)).toBe(false);
    }
  });

  it("does nothing at all when storage is denied", () => {
    expect(() => stashAcquisition(hostileStorage, { source: "x" })).not.toThrow();
    expect(() =>
      rememberAcquisitionFromLocation(hostileStorage, {
        search: "?utm_source=x",
        pathname: "/",
      }),
    ).not.toThrow();
    expect(takeAcquisition(hostileStorage)).toBeNull();
    expect(takeAcquisition(null)).toBeNull();
    expect(() => stashAcquisition(null, { source: "x" })).not.toThrow();
  });

  it("stores no identifier of any kind", () => {
    // The cookie notice promises the key holds no id. Pin the shape so that a
    // later "helpful" addition has to come through this test.
    rememberAcquisitionFromLocation(storage, {
      search: "?utm_source=google&utm_medium=cpc&utm_campaign=c&gclid=g&ref=r",
      pathname: "/tela",
    });
    const stored = JSON.parse(storage.map.get(ACQUISITION_KEY)!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(stored).sort()).toEqual(
      ["at", "campaign", "gclid", "landing", "medium", "ref", "source"].sort(),
    );
  });
});
